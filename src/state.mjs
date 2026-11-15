import {mkdirSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,fsyncSync,unlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export class StateStore {
  constructor(directory) {this.directory=directory;this.file=join(directory,'state.json');this.lock=join(directory,'collector.lock');this.owner=null;this.data=null;}
  open() {
    mkdirSync(this.directory,{recursive:true,mode:0o700});
    this.owner=randomUUID();
    try{writeFileSync(this.lock,JSON.stringify({owner:this.owner,pid:process.pid,createdAt:new Date().toISOString()}),{flag:'wx',mode:0o600});}
    catch{this.owner=null;throw new Error('Collector state is locked; stop other collectors and inspect a stale lock before removing it');}
    try {
      this.data=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{version:1,mailboxes:{}};
      if(this.data.version!==1 || !this.data.mailboxes || typeof this.data.mailboxes!=='object')throw new Error('Unsupported collector state');
    }catch(error){this.close();throw error;}
  }
  save() {
    if(!this.owner)throw new Error('State is not locked');
    const temp=join(this.directory,`.state-${randomUUID()}.tmp`);
    const fd=openSync(temp,'wx',0o600);
    try{writeFileSync(fd,JSON.stringify(this.data,null,2));fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temp,this.file);
    const dir=openSync(this.directory,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
  }
  close() {
    if(this.owner){const owner=JSON.parse(readFileSync(this.lock,'utf8')).owner;if(owner!==this.owner)throw new Error('State lock ownership changed');unlinkSync(this.lock);this.owner=null;}
  }
}
