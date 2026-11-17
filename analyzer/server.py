import base64
import binascii
import codecs
import hmac
import http.client
import io
import ipaddress
import json
import os
import socket
import ssl
import time
import zlib
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, HTTPServer
from email.message import Message
from urllib.parse import urljoin, urlsplit

from pypdf import PdfReader
from pypdf.errors import PdfReadError

BASE_HOSTS = {
    "marches-securises.fr", "boamp.fr", "marches-publics.gouv.fr",
    "achatpublic.com", "aws-achat.info", "e-marchespublics.com",
}
ALLOWED_HOSTS = frozenset(host for base in BASE_HOSTS for host in (base, "www." + base))
MAX_EMAIL_SIZE = 15 * 1024 * 1024
MAX_REQUEST = ((MAX_EMAIL_SIZE + 2) // 3) * 4 + 1024 * 1024
MAX_DOCUMENT = 1024 * 1024
MAX_ATTACHMENT = MAX_EMAIL_SIZE
MAX_TEXT = 12000
MAX_URLS = 5
MAX_ATTACHMENTS = 5
TIMEOUT = 15


class AnalysisError(Exception):
    pass


def public_addresses(host):
    try:
        addresses = {entry[4][0] for entry in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
    except OSError as error:
        raise AnalysisError("dns_failed") from error
    if not addresses:
        raise AnalysisError("dns_failed")
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if (not ip.is_global or ip.is_multicast or ip.is_reserved or ip.is_link_local
                or (ip.version == 6 and ip.ipv4_mapped and not ip.ipv4_mapped.is_global)):
            raise AnalysisError("non_public_address")
    ipv4 = [address for address in addresses if ipaddress.ip_address(address).version == 4]
    if not ipv4:
        raise AnalysisError("no_public_ipv4")
    return sorted(ipv4)


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, address):
        super().__init__(host, 443, timeout=TIMEOUT, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        raw = socket.create_connection((self.address, 443), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except (OSError, ssl.SSLError, ValueError):
            raw.close()
            raise


def validate_url(url):
    try:
        if not url or any(ord(char) < 33 or ord(char) > 126 for char in url):
            raise AnalysisError("url_not_allowed")
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.port not in (None, 443)
                or parsed.hostname.lower() not in ALLOWED_HOSTS):
            raise AnalysisError("url_not_allowed")
    except ValueError as error:
        raise AnalysisError("url_not_allowed") from error
    return parsed


def download(url):
    deadline = time.monotonic() + TIMEOUT
    for redirect in range(4):
        parsed = validate_url(url)
        address = public_addresses(parsed.hostname)[0]
        connection = PinnedHTTPSConnection(parsed.hostname, address)
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AnalysisError("timeout")
            connection.timeout = remaining
            target = parsed.path or "/"
            if parsed.query:
                target += "?" + parsed.query
            connection.request("GET", target, headers={"Accept": "text/html,application/pdf", "Accept-Encoding": "identity"})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location or redirect == 3:
                    raise AnalysisError("invalid_redirect")
                url = urljoin(url, location)
                continue
            if response.status != 200:
                raise AnalysisError("http_error")
            encoding = response.getheader("Content-Encoding", "identity").lower()
            if encoding not in {"identity", "gzip"}:
                raise AnalysisError("unsupported_encoding")
            content_header = response.getheader("Content-Type", "")
            content_type = content_header.split(";", 1)[0].strip().lower()
            metadata = Message()
            metadata["Content-Type"] = content_header
            charset = metadata.get_content_charset() or "utf-8"
            chunks, size = [], 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise AnalysisError("timeout")
                if connection.sock:
                    connection.sock.settimeout(remaining)
                chunk = response.read1(min(65536, MAX_DOCUMENT + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_DOCUMENT:
                    raise AnalysisError("document_too_large")
            body = b"".join(chunks)
            if encoding == "gzip":
                try:
                    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
                    body = decoder.decompress(body, MAX_DOCUMENT + 1)
                except zlib.error as error:
                    raise AnalysisError("invalid_compressed_document") from error
                if len(body) > MAX_DOCUMENT:
                    raise AnalysisError("document_too_large")
                if not decoder.eof or decoder.unused_data:
                    raise AnalysisError("invalid_compressed_document")
            return url, content_type, charset, body
        except (OSError, http.client.HTTPException, ssl.SSLError) as error:
            raise AnalysisError("network_error") from error
        finally:
            connection.close()
    raise AnalysisError("invalid_redirect")


class VisibleText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "noscript"}:
            self.hidden += 1
        elif tag in {"p", "div", "br", "li", "tr", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style", "noscript"} and self.hidden:
            self.hidden -= 1

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def extract_pdf(data, max_size=MAX_DOCUMENT):
    if len(data) > max_size:
        raise AnalysisError("document_too_large")
    if not data.startswith(b"%PDF-"):
        raise AnalysisError("invalid_pdf")
    try:
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise AnalysisError("encrypted_pdf")
        count = len(reader.pages)
        text = "\n".join(reader.pages[i].extract_text() or "" for i in range(min(count, 20)))
    except AnalysisError:
        raise
    except (PdfReadError, ValueError, TypeError, KeyError, IndexError, RecursionError, OSError) as error:
        raise AnalysisError("pdf_parse_failed") from error
    return {"text": text[:MAX_TEXT], "truncated": len(text) > MAX_TEXT or count > 20,
            "warning": "no_extractable_text" if not text.strip() else None}


def analyze(payload):
    if not isinstance(payload, dict) or set(payload) != {"attachments", "urls"}:
        raise AnalysisError("invalid_request")
    attachments, urls = payload["attachments"], payload["urls"]
    if (not isinstance(attachments, list) or len(attachments) > MAX_ATTACHMENTS
            or not isinstance(urls, list) or len(urls) > MAX_URLS):
        raise AnalysisError("request_limit")
    results = []
    for attachment in attachments:
        if not isinstance(attachment, dict) or set(attachment) != {"name", "data"}:
            raise AnalysisError("invalid_attachment")
        name, encoded = attachment["name"], attachment["data"]
        if not isinstance(name, str) or len(name) > 256 or not isinstance(encoded, str):
            raise AnalysisError("invalid_attachment")
        try:
            raw = base64.b64decode(encoded, validate=True)
            result = extract_pdf(raw, MAX_ATTACHMENT)
            results.append({"source": "attachment", "name": name, **result})
        except (binascii.Error, ValueError):
            results.append({"source": "attachment", "name": name, "error": "invalid_base64"})
        except AnalysisError as error:
            results.append({"source": "attachment", "name": name, "error": str(error)})
    for url in urls:
        if not isinstance(url, str) or len(url) > 2048:
            raise AnalysisError("invalid_url")
        try:
            final_url, content_type, charset, raw = download(url)
            if content_type == "application/pdf":
                result = extract_pdf(raw)
            elif content_type in {"text/html", "text/plain"}:
                try:
                    codecs.lookup(charset)
                    text = raw.decode(charset, errors="replace")
                except LookupError as error:
                    raise AnalysisError("unsupported_charset") from error
                if content_type == "text/html":
                    parser = VisibleText()
                    parser.feed(text)
                    text = " ".join(parser.parts)
                result = {"text": text[:MAX_TEXT], "truncated": len(text) > MAX_TEXT}
            else:
                raise AnalysisError("unsupported_content_type")
            results.append({"source": "url", "url": url, "finalUrl": final_url, **result})
        except AnalysisError as error:
            results.append({"source": "url", "url": url, "error": str(error)})
    remaining = 40000
    for result in results:
        if isinstance(result.get("text"), str):
            text = result["text"]
            result["text"] = text[:remaining]
            result["truncated"] = result.get("truncated", False) or len(text) > remaining
            remaining -= len(result["text"])
    return {"documents": results}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_POST(self):
        self.connection.settimeout(TIMEOUT)
        authorization = self.headers.get("Authorization", "").encode("latin-1")
        if self.path != "/analyze" or not hmac.compare_digest(
                authorization, b"Bearer " + self.server.token):
            self.send_error(403)
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
            if length < 1 or length > MAX_REQUEST:
                raise AnalysisError("request_limit")
            data = self.rfile.read(length)
            if len(data) != length:
                raise AnalysisError("invalid_request")
            result = analyze(json.loads(data))
            output = json.dumps(result, ensure_ascii=False).encode("utf-8")
        except (ValueError, UnicodeError, AnalysisError):
            self.send_error(400)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(output)))
        self.end_headers()
        self.wfile.write(output)


def create_server(address, token, cert_file, key_file):
    if len(token) < 32 or any(ord(char) < 33 or ord(char) > 126 for char in token):
        raise ValueError("ANALYZER_TOKEN must contain at least 32 printable ASCII characters without spaces")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert_file, key_file)
    server = HTTPServer(address, Handler)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.token = token.encode("ascii")
    return server


if __name__ == "__main__":
    server = create_server(("0.0.0.0", 8080), os.environ.get("ANALYZER_TOKEN", ""),
                           os.environ["ANALYZER_TLS_CERT_FILE"], os.environ["ANALYZER_TLS_KEY_FILE"])
    server.serve_forever()
