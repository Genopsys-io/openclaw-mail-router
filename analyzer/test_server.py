import base64
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import ssl
import tempfile
import threading
import unittest
from unittest.mock import patch

from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
from http.client import HTTPConnection

import server


def pdf():
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=200)
    font = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    })
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)}),
    })
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 12 Tf 10 100 Td (Call for tenders) Tj ET")
    page[NameObject("/Contents")] = writer._add_object(stream)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


class AnalyzerTests(unittest.TestCase):
    def test_pdf_is_extracted_and_invalid_pdf_is_explicit(self):
        body = {"attachments": [
            {"name": "notice.pdf", "data": base64.b64encode(pdf()).decode()},
            {"name": "bad.pdf", "data": base64.b64encode(b"not pdf").decode()},
        ], "urls": []}
        documents = server.analyze(body)["documents"]
        self.assertIn("Call for tenders", documents[0]["text"])
        self.assertEqual(documents[1]["error"], "invalid_pdf")

    def test_url_domain_and_scheme_checks(self):
        for value in ["http://boamp.fr/", "https://boamp.fr.evil.example/", "https://boamp.fr@evil.example/",
                      "https://www.boamp.fr/", "https://boamp.fr:444/"]:
            with self.subTest(value=value), self.assertRaises(server.AnalysisError):
                server.validate_url(value)
        self.assertEqual(server.validate_url("https://boamp.fr/notice").hostname, "boamp.fr")
        for host in server.ALLOWED_HOSTS:
            self.assertEqual(server.validate_url(f"https://{host}/notice").hostname, host)

    def test_dns_rejects_private_or_mixed_answers(self):
        for addresses in [["8.8.8.8", "127.0.0.1"], ["::1"], ["::ffff:127.0.0.1"], ["224.0.0.1"]]:
            records = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", (ip, 443)) for ip in addresses]
            with patch.object(server.socket, "getaddrinfo", return_value=records):
                with self.assertRaisesRegex(server.AnalysisError, "non_public_address"):
                    server.public_addresses("boamp.fr")

    def test_ipv6_only_host_is_reported_without_connecting(self):
        records = [(socket.AF_INET6, socket.SOCK_STREAM, 0, "", ("2606:4700:4700::1111", 443, 0, 0))]
        with patch.object(server.socket, "getaddrinfo", return_value=records):
            with self.assertRaisesRegex(server.AnalysisError, "no_public_ipv4"):
                server.public_addresses("boamp.fr")

    def test_redirect_is_rechecked_before_network_access(self):
        class FakeResponse:
            status = 302
            def getheader(self, name, default=None):
                return "https://evil.example/notice" if name == "Location" else default

        class FakeConnection:
            def __init__(self, host, ip):
                pass
            def request(self, *args, **kwargs):
                pass
            def getresponse(self):
                return FakeResponse()
            def close(self):
                pass

        with patch.object(server, "public_addresses", return_value=["8.8.8.8"]) as dns, \
             patch.object(server, "PinnedHTTPSConnection", FakeConnection):
            with self.assertRaisesRegex(server.AnalysisError, "url_not_allowed"):
                server.download("https://boamp.fr/notice")
            dns.assert_called_once_with("boamp.fr")

    def test_allowed_page_is_fetched_with_pinned_public_address(self):
        requests = []

        class FakeResponse:
            status = 200
            def __init__(self):
                self.body = io.BytesIO("<h1>Marché</h1><script>hidden</script><p>Details</p>".encode("cp1252"))
            def getheader(self, name, default=None):
                return {"Content-Type": "text/html; charset=windows-1252", "Content-Encoding": "identity"}.get(name, default)
            def read1(self, count):
                return self.body.read(count)

        class FakeConnection:
            sock = None
            def __init__(self, host, ip):
                requests.append((host, ip))
            def request(self, method, target, headers):
                requests.append((method, target))
            def getresponse(self):
                return FakeResponse()
            def close(self):
                pass

        with patch.object(server, "public_addresses", return_value=["8.8.8.8"]), \
             patch.object(server, "PinnedHTTPSConnection", FakeConnection):
            result = server.analyze({"attachments": [], "urls": ["https://boamp.fr/notice"]})
        self.assertEqual(requests, [("boamp.fr", "8.8.8.8"), ("GET", "/notice")])
        self.assertIn("Marché", result["documents"][0]["text"])
        self.assertNotIn("hidden", result["documents"][0]["text"])

    def test_url_rejection_reported_without_request(self):
        with patch.object(server, "public_addresses") as dns:
            result = server.analyze({"attachments": [], "urls": ["https://evil.example/"]})
        self.assertEqual(result["documents"][0]["error"], "url_not_allowed")
        dns.assert_not_called()

    def test_http_endpoint_requires_token_and_extracts_pdf(self):
        httpd = server.HTTPServer(("127.0.0.1", 0), server.Handler)
        httpd.token = b"a" * 32
        worker = threading.Thread(target=httpd.serve_forever)
        worker.start()
        try:
            connection = HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            connection.request("POST", "/analyze", body="{}", headers={"Authorization": "Bearer wrong"})
            response = connection.getresponse()
            self.assertEqual(response.status, 403)
            response.read()
            connection.close()

            payload = '{"attachments":[{"name":"notice.pdf","data":"' + base64.b64encode(pdf()).decode() + '"}],"urls":[]}'
            connection = HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            connection.request("POST", "/analyze", body=payload, headers={"Authorization": "Bearer " + httpd.token.decode()})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertIn(b"Call for tenders", response.read())
            connection.close()
        finally:
            httpd.shutdown()
            worker.join()
            httpd.server_close()

    def test_node_client_to_isolated_http_analyzer(self):
        httpd = server.HTTPServer(("127.0.0.1", 0), server.Handler)
        httpd.token = b"a" * 32
        worker = threading.Thread(target=httpd.serve_forever)
        worker.start()
        try:
            script = """
              const {createAnalyzer} = await import(process.env.MODULE);
              let data=''; for await (const chunk of process.stdin) data += chunk;
              const analyzer = createAnalyzer({
                MAIL_ROUTER_ANALYZER_URL:'https://analyzer.openclaw-aisa.svc.cluster.local:8080/analyze',
                MAIL_ROUTER_ANALYZER_TOKEN:'a'.repeat(32),
              }, (_, options) => fetch(`http://127.0.0.1:${process.env.PORT}/analyze`, options));
              const result = await analyzer({
                attachments:[{contentType:'application/pdf',filename:'notice.pdf',content:Buffer.from(data,'base64')}],
                text:'https://evil.example/notice',
              });
              console.log(JSON.stringify(result));
            """
            env = {**os.environ, "PORT": str(httpd.server_port),
                   "MODULE": (Path(__file__).resolve().parent.parent / "src" / "analyzer.mjs").as_uri()}
            result = subprocess.run(["node", "--input-type=module", "-e", script],
                                    input=base64.b64encode(pdf()).decode(), env=env,
                                    text=True, capture_output=True, check=True, timeout=15)
            data = json.loads(result.stdout)
            self.assertIn("Call for tenders", data["documents"][0]["text"])
            self.assertEqual(data["skippedUrls"], 1)
        finally:
            httpd.shutdown()
            worker.join()
            httpd.server_close()

    def test_tls_server_requires_valid_hostname_and_authenticates(self):
        hostname = "analyzer.openclaw-aisa.svc.cluster.local"
        with tempfile.TemporaryDirectory() as directory:
            cert = str(Path(directory) / "cert.pem")
            key = str(Path(directory) / "key.pem")
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                            "-subj", "/CN=" + hostname, "-addext", "subjectAltName=DNS:" + hostname,
                            "-keyout", key, "-out", cert], check=True, capture_output=True, timeout=15)
            httpd = server.create_server(("127.0.0.1", 0), "a" * 32, cert, key)
            worker = threading.Thread(target=httpd.serve_forever)
            worker.start()
            try:
                context = ssl.create_default_context(cafile=cert)
                with socket.create_connection(("127.0.0.1", httpd.server_port), timeout=5) as raw:
                    with context.wrap_socket(raw, server_hostname=hostname) as connection:
                        body = b'{"attachments":[],"urls":[]}'
                        connection.sendall(b"POST /analyze HTTP/1.1\r\nHost: " + hostname.encode()
                                           + b"\r\nAuthorization: Bearer " + b"a" * 32
                                           + b"\r\nContent-Length: " + str(len(body)).encode()
                                           + b"\r\nConnection: close\r\n\r\n" + body)
                        response = b""
                        while chunk := connection.recv(4096):
                            response += chunk
                        self.assertIn(b"200 OK", response)
                        self.assertIn(b'"documents": []', response)
            finally:
                httpd.shutdown()
                worker.join()
                httpd.server_close()


if __name__ == "__main__":
    unittest.main()
