/**
 * @name Backup Data Discord Server
 * @author Backup Data Discord Server
 * @description Back up your server channels with pause and resume, then read, search, and copy messages in a local offline archive.
 * @version 0.1.6
 */
'use strict';
// Single-file build. No remote code loading. Settings and archive format remain backward compatible.
const __factories={
"./meta":function(module,exports,require){
'use strict';
// Generated from release.json.
module.exports={
  "NAME": "Backup Data Discord Server",
  "VERSION": "0.1.6",
  "STORAGE_KEY": "DiscordArchive"
};

},
"./runtime":function(module,exports,require){
'use strict';
// BetterDiscord exposes a subset of Node through a bridge, not a full Node runtime.
// Keep the external module list explicit. Never escape the host's module loader.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const processInfo = require('process');
const bufferModule = require('buffer');
const Buffer = bufferModule.Buffer || bufferModule;

function filesystemError(error) {
    // Errors crossing Electron's bridge can lose custom properties such as .code.
    const e = error instanceof Error ? error : new Error(String(error?.message || error));
    if (!e.code) {
        const match = String(e.message).match(/\b(E[A-Z0-9]+):/);
        if (match) e.code = match[1];
    }
    return e;
}
function sync(name, ...args) {
    try {
        if (typeof fs[name] !== 'function') throw new Error(`BetterDiscord does not expose fs.${name}, which this plugin requires`);
        return fs[name](...args);
    } catch (error) { throw filesystemError(error); }
}
function binary(value) {
    if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    if (Array.isArray(value)) return Buffer.from(value);
    throw new Error('BetterDiscord returned binary file data in an unsupported format — the file will not be marked as saved');
}
// Promise-shaped facade for our engine. The host's filesystem bridge itself is
// synchronous; these are NOT fs.promises or off-thread filesystem operations.
const fsp = {
    async mkdir(file, options) { return sync('mkdirSync', file, options); },
    async readFile(file, encoding = null) {
        // Explicit null is essential: BD's readFile defaults to UTF-8 otherwise.
        const data = sync('readFileSync', file, encoding);
        if (encoding) return typeof data === 'string' ? data : binary(data).toString(encoding);
        return binary(data);
    },
    async writeFile(file, data, options = {}) { return sync('writeFileSync', file, data, options); },
    async rename(from, to) { return sync('renameSync', from, to); },
    async unlink(file) { return sync('unlinkSync', file); },
    async stat(file) { return sync('statSync', file); },
    async readdir(file, options = {}) {
        // Do not rely on Dirent prototypes surviving Electron's context bridge.
        const names = sync('readdirSync', file);
        if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw new Error('Local file list is invalid');
        if (!options.withFileTypes) return names;
        return names.map(name => {
            const stats = sync('statSync', path.join(file, name));
            return {name, isDirectory: () => stats.isDirectory(), isFile: () => stats.isFile()};
        });
    }
};
function randomHex(bytes = 16) { return binary(crypto.randomBytes(bytes)).toString('hex'); }
function defaultFolder() {
    const env = processInfo?.env || {};
    const home = env.USERPROFILE || env.HOME || ((env.HOMEDRIVE && env.HOMEPATH) ? env.HOMEDRIVE + env.HOMEPATH : '');
    return home && path.isAbsolute(home) ? path.join(home, 'Documents', 'DiscordArchive') : '';
}
// One renderer-session registry survives plugin hot reload. Other sessions are
// never pronounced dead using process.kill(): BD intentionally makes it a no-op.
const lockKey = Symbol.for('DiscordArchive.writerRegistry.v1');
function writerRegistry() {
    if (!globalThis[lockKey]) globalThis[lockKey] = {session: randomHex(), held: new Map()};
    return globalThis[lockKey];
}
function runtimeSummary() {
    return {filesystem: 'BetterDiscord sync bridge', fileHandles: false, nodeStreams: false,
        attachmentTransport: 'BdApi.Net.fetch', platform: String(processInfo?.platform || 'unknown')};
}
module.exports = {fs, fsp, path, crypto, Buffer, processInfo, sync, binary, randomHex, defaultFolder, writerRegistry, runtimeSummary};

},
"./core":function(module,exports,require){
'use strict';
// Storage / incremental history engine. No Discord or DOM dependencies.
const {fsp,path,crypto,Buffer,randomHex,writerRegistry} = require('./runtime');
const {VERSION} = require('./meta');
const PREFIX = 'window.DiscordArchiveData(';
const SUFFIX = ');\n';
const ID = /^\d{1,22}$/;
const PART = /^channels\/\d{1,22}\/parts\/\d{1,22}-\d{1,22}\.js$/;
const now = () => new Date().toISOString();
const copy = o => JSON.parse(JSON.stringify(o));
function id(v) { v = String(v); if (!ID.test(v)) throw new Error('Invalid Discord ID'); return v; }
function cmp(a,b) { a=BigInt(a); b=BigInt(b); return a<b?-1:a>b?1:0; }
function abortError() { const e=new Error('Paused — click Back Up to resume'); e.name='AbortError'; return e; }
function check(signal) { if (signal?.aborted) throw abortError(); }
function sleep(ms,signal) {
    check(signal);
    return new Promise((resolve,reject)=>{
        const done=()=>{signal?.removeEventListener('abort',stop); resolve();};
        const t=setTimeout(done,Math.max(0,ms));
        const stop=()=>{clearTimeout(t); signal?.removeEventListener('abort',stop); reject(abortError());};
        signal?.addEventListener('abort',stop,{once:true});
    });
}
function safeJSON(o) {
    return JSON.stringify(o).replace(/</g,'\\u003c').replace(/>/g,'\\u003e')
        .replace(/&/g,'\\u0026').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
}
function encodePart(o) { return PREFIX+safeJSON(o)+SUFFIX; }
function decodePart(text) {
    // NEVER eval / require user-generated data files in the Electron/Node process.
    if (!text.startsWith(PREFIX) || !text.endsWith(SUFFIX)) throw new Error('Invalid message data file format');
    const x=JSON.parse(text.slice(PREFIX.length,-SUFFIX.length));
    if (x.schema!==1 || !ID.test(x.channelId) || !Array.isArray(x.messages)) throw new Error('Invalid message data structure');
    for (const m of x.messages) if (!ID.test(m.id) || String(m.channel_id)!==x.channelId) throw new Error('Message ID / Channel ID mismatch');
    return x;
}
function digest(v) { return crypto.createHash('sha256').update(v).digest('hex'); }
function safeName(n) { return String(n||'attachment').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,100)||'attachment'; }
async function atomicWrite(file,data) {
    await fsp.mkdir(path.dirname(file),{recursive:true});
    const tmp=file+'.tmp-'+randomHex(6);
    try {
        // flush is forwarded to Node's writeFileSync by BD's supported bridge.
        // Do not use open/FileHandle/fsync, which the bridge does not expose.
        await fsp.writeFile(tmp,data,{flag:'wx',mode:0o600,flush:true});
        await fsp.rename(tmp,file); // Never unlink the old version first.
    } catch(e) {await fsp.unlink(tmp).catch(()=>{});throw e;}
}
async function readJSON(file,defaultValue) {
    try { return JSON.parse(await fsp.readFile(file,'utf8')); }
    catch(e) { if(e.code==='ENOENT' && defaultValue!==undefined) return copy(defaultValue); throw e; }
}
function channelSummary(s) {
    const p=s.parts||[];
    return {
        id:s.id,name:s.name,type:s.type,parentId:s.parentId,category:s.category,topic:s.topic,
        count:p.reduce((n,x)=>n+x.count,0),files:p.reduce((n,x)=>n+x.files,0),
        pending:p.reduce((n,x)=>n+x.pending,0),savedFiles:p.reduce((n,x)=>n+x.files-x.pending,0),
        from:p.length?p[0].from:null,to:p.length?p[p.length-1].to:null,
        historyComplete:!!s.historyComplete,through:s.completeThrough,checkedAt:s.checkedAt||null,
        inProgress:!!s.run,error:s.error||null,parts:p,metadataFile:`channels/${s.id}/state.json`
    };
}
class DiskArchive {
    constructor(root,guild,assets={},options={}) { this.root=path.resolve(root); this.guild=copy(guild); id(guild.id); this.assets=assets; this.states=new Map(); this.lock=null; this.confirmUnlock=options.confirmUnlock; }
    resolve(rel) {
        if (typeof rel!=='string' || rel.includes('\\') || rel.split('/').includes('..') || path.isAbsolute(rel)) throw new Error('Invalid archive path');
        const p=path.resolve(this.root,rel);
        if (!p.startsWith(this.root+path.sep)) throw new Error('Path outside archive');
        return p;
    }
    async acquire() {
        const registry=writerRegistry();
        if(this.lock || registry.held.has(this.root))throw new Error('This archive is already being used by another backup job');
        await fsp.mkdir(this.root,{recursive:true});
        const file=this.resolve('.writer.lock');
        const owner={schema:2,token:randomHex(),session:registry.session,started:now()};
        const create=()=>fsp.writeFile(file,JSON.stringify(owner),{flag:'wx',mode:0o600,flush:true});
        try {await create();}
        catch(e) {
            if(e.code!=='EEXIST')throw e;
            const previous=await fsp.readFile(file,'utf8');
            // No PID guessing or silent takeover of another Discord process.
            if(typeof this.confirmUnlock!=='function' || !await this.confirmUnlock(this.root))throw new Error('Found a lock file from a previous run or another Discord window — archive writing has not started');
            if(registry.held.has(this.root) || await fsp.readFile(file,'utf8')!==previous)throw new Error('The lock state changed during confirmation — will not take over another backup job');
            await fsp.unlink(file);await create();
        }
        this.lock=owner;registry.held.set(this.root,owner.token);
    }
    async assertLock() {
        if(!this.lock)return; // Standalone storage tests may operate without acquire().
        const current=await readJSON(this.resolve('.writer.lock'),null);
        if(current?.token!==this.lock.token)throw new Error('Archive write ownership changed — stopping to prevent concurrent writes');
    }
    async release() {
        const own=this.lock;if(!own)return;this.lock=null;
        const registry=writerRegistry();
        try {
            const current=await readJSON(this.resolve('.writer.lock'),null);
            if(current?.token===own.token)await fsp.unlink(this.resolve('.writer.lock'));
        } finally {if(registry.held.get(this.root)===own.token)registry.held.delete(this.root);}
    }
    async init() {
        await this.assertLock();
        await fsp.mkdir(this.resolve('channels'),{recursive:true});
        this.info=await readJSON(this.resolve('archive.json'),{schema:1,version:VERSION,guild:this.guild,createdAt:now(),scope:{},warnings:[]});
        if (this.info.schema!==1 || String(this.info.guild.id)!==String(this.guild.id)) throw new Error('This folder belongs to a different server archive or uses an unsupported format');
        this.info.guild=this.guild; this.info.version=VERSION;
        const dirs=await fsp.readdir(this.resolve('channels'),{withFileTypes:true});
        for(const d of dirs) if(d.isDirectory() && ID.test(d.name)) {
            const s=await readJSON(this.resolve(`channels/${d.name}/state.json`),null);
            if(!s)continue;
            this.validateState(s); this.states.set(s.id,s);
        }
        await this.recoverJournals();
        for(const [name,data] of Object.entries(this.assets)) await atomicWrite(this.resolve(name),data);
        await this.publish();
    }
    validateState(s) {
        if(s.schema!==1 || !ID.test(s.id) || !Array.isArray(s.parts))throw new Error('Channel state file is corrupted — not starting over on top of existing data');
        let last=null;
        for(const p of s.parts) {
            if(!PART.test(p.file) || !p.file.startsWith(`channels/${s.id}/`) || !ID.test(p.lo) || !ID.test(p.hi) || cmp(p.lo,p.hi)>0 || (last!==null && cmp(last,p.lo)>=0)) throw new Error('Duplicate message range or invalid data file format');
            last=p.hi;
        }
        if(s.run) {id(s.run.before); id(s.run.lower); id(s.run.upper);}
    }
    async state(channel) {
        const cid=id(channel.id);
        let s=this.states.get(cid);
        if(!s) {
            s={schema:1,id:cid,parts:[],completeThrough:'0',historyComplete:false,run:null,error:null};
            this.states.set(cid,s);
        }
        Object.assign(s,{name:String(channel.name||cid),type:channel.type,parentId:channel.parent_id||channel.parentId||null,category:channel.category||'',topic:channel.topic||''});
        // Cheap corruption check only. Full hashes are checked whenever a part is read.
        for(const p of s.parts) {
            const st=await fsp.stat(this.resolve(p.file)).catch(()=>null);
            if(!st || st.size!==p.bytes)throw new Error(`Message data file is missing or its size changed: ${p.file} — stopping to avoid skipping data`);
        }
        await this.saveState(s); return s;
    }
    async saveState(s) {
        await this.assertLock();
        s.parts.sort((a,b)=>cmp(a.lo,b.lo)); this.validateState(s);
        await atomicWrite(this.resolve(`channels/${s.id}/state.json`),JSON.stringify(s,null,2));
        this.states.set(s.id,s); await this.publish();
    }
    async publish() {
        await this.assertLock();
        this.info.updatedAt=now();
        const catalog={...this.info,channels:[...this.states.values()].map(channelSummary)};
        catalog.channels.sort((a,b)=>(a.category||'').localeCompare(b.category||'','th')||a.name.localeCompare(b.name,'th'));
        await atomicWrite(this.resolve('archive.json'),JSON.stringify(this.info,null,2));
        await atomicWrite(this.resolve('catalog.js'),'window.DiscordArchiveCatalog='+safeJSON(catalog)+';\n');
        this.catalog=catalog;
    }
    async readPart(p) {
        if(!PART.test(p.file))throw new Error('Invalid part path');
        const buf=await fsp.readFile(this.resolve(p.file));
        if(p.sha256 && digest(buf)!==p.sha256)throw new Error(`Message data file changed or is corrupted: ${p.file}`);
        return decodePart(buf.toString('utf8'));
    }
    async commit(s,messages,advance) {
        if(!messages.length) {if(advance)s.run.before=advance; await this.saveState(s); return null;}
        messages.sort((a,b)=>cmp(a.id,b.id));
        const lo=id(messages[0].id),hi=id(messages[messages.length-1].id);
        const file=`channels/${s.id}/parts/${lo}-${hi}.js`;
        for(const p of s.parts) if(cmp(lo,p.hi)<=0 && cmp(hi,p.lo)>=0)throw new Error('Overlapping message ranges — not duplicating or skipping data');
        const p=await this.writePart(file,s.id,messages);
        s.parts.push(p); if(advance)s.run.before=advance;
        await this.saveState(s); return p;
    }
    async writePart(file,cid,messages) {
        await this.assertLock();
        const data=encodePart({schema:1,channelId:cid,messages});
        await atomicWrite(this.resolve(file),data);
        let files=0,pending=0;
        for(const m of messages)for(const a of m.attachments||[]) {files++; if(a._archive?.status!=='saved')pending++;}
        return {file,lo:messages[0].id,hi:messages[messages.length-1].id,count:messages.length,
            from:messages[0].timestamp,to:messages[messages.length-1].timestamp,
            files,pending,bytes:Buffer.byteLength(data),sha256:digest(data)};
    }
    async updatePart(s,p,messages) {
        // Journal attachment-only updates so interruption between part/state writes
        // can be completed on the next open. Message text and IDs never change here.
        const journal={part:p.file,oldSha:p.sha256,newData:encodePart({schema:1,channelId:s.id,messages}),oldMeta:p};
        const jf=this.resolve(`channels/${s.id}/attachment-journal.json`);
        await atomicWrite(jf,JSON.stringify(journal));
        const updated=await this.writePart(p.file,s.id,messages);
        s.parts=s.parts.map(x=>x.file===p.file?updated:x);
        await this.saveState(s); await fsp.unlink(jf);
        return updated;
    }
    async recoverJournals() {
        for(const s of this.states.values()) {
            const jf=this.resolve(`channels/${s.id}/attachment-journal.json`);
            const j=await readJSON(jf,null); if(!j)continue;
            if(!PART.test(j.part) || !j.part.startsWith(`channels/${s.id}/`))throw new Error('Invalid recovery journal');
            const payload=decodePart(j.newData);
            if(payload.channelId!==s.id)throw new Error('Recovery journal has the wrong channel');
            const current=s.parts.find(p=>p.file===j.part); if(!current)throw new Error('Recovery journal refers to unknown part');
            const p=await this.writePart(j.part,s.id,payload.messages);
            s.parts=s.parts.map(x=>x.file===j.part?p:x); await this.saveState(s); await fsp.unlink(jf);
        }
    }
}
function normalizeMessage(m,cid) {
    if(!m || typeof m.id!=='string' || !ID.test(m.id) || String(m.channel_id)!==String(cid) || typeof m.content!=='string' || !Array.isArray(m.attachments))throw new Error('Discord returned an unsupported message shape — backup is not considered complete');
    const x=copy(m); delete x._archive;
    for(const a of x.attachments) {id(a.id); a._archive={status:'pending'};}
    return x;
}
function page(raw,cid,before=null) {
    if(!Array.isArray(raw))throw new Error('The history response is not a message list');
    const seen=new Set();const items=[];
    for(const x of raw) {
        const m=normalizeMessage(x,cid);
        if(before && cmp(m.id,before)>=0)throw new Error('Discord returned a history page that does not match the cursor — stopping to avoid skipping history');
        if(!seen.has(m.id)){seen.add(m.id);items.push(m);}
    }
    return items.sort((a,b)=>cmp(b.id,a.id));
}
class HistoryEngine {
    constructor(disk,api,{signal,onProgress=()=>{},files=true,download=downloadAttachment}={}) {
        this.disk=disk;this.api=api;this.signal=signal;this.onProgress=onProgress;this.files=files;this.download=download;
        this.added=0;this.filesSaved=0;this.attemptedFiles=new Set();
    }
    emit(s,stage,extra={}) {this.onProgress({channel:s.name,channelId:s.id,stage,added:this.added,filesSaved:this.filesSaved,total:s.parts.reduce((n,p)=>n+p.count,0),pending:s.parts.reduce((n,p)=>n+p.pending,0),...extra});}
    async backup(channel) {
        const s=await this.disk.state(channel); s.error=null;
        try {
            check(this.signal);await this.api.validateChannel(s.id,this.signal);
            // Restore an interrupted snapshot before starting the snapshot for this click.
            if(s.run) await this.walk(s);
            check(this.signal);
            const recent=page(await this.api.messages(s.id,{limit:100},this.signal),s.id);
            check(this.signal);
            if(recent.length && cmp(recent[0].id,s.completeThrough)>0) {
                const upper=recent[0].id;
                s.run={lower:s.completeThrough,upper,before:String(BigInt(upper)+1n),startedAt:now()};
                await this.disk.saveState(s);
                await this.walk(s,recent);
            } else {
                // A successful empty response alone is NOT proof of authorization.
                await this.api.validateChannel(s.id,this.signal);
                s.historyComplete=true;s.checkedAt=now();await this.disk.saveState(s);
            }
            if(this.files)await this.repairFiles(s);
            this.emit(s,'done');return channelSummary(s);
        } catch(e) {
            s.error=e.name==='AbortError'?null:String(e.message||e);
            await this.disk.saveState(s).catch(()=>{});
            this.emit(s,e.name==='AbortError'?'paused':'error',{error:s.error});throw e;
        }
    }
    async walk(s,initial=null) {
        while(s.run) {
            check(this.signal);
            const run=s.run;
            this.emit(s,'messages',{before:run.before});
            const p=initial||page(await this.api.messages(s.id,{limit:100,before:run.before},this.signal),s.id,run.before);
            initial=null;check(this.signal);
            if(!p.length) {
                await this.api.validateChannel(s.id,this.signal); await this.finish(s);break;
            }
            const oldest=p[p.length-1].id;
            if(cmp(oldest,run.before)>=0)throw new Error('History cursor did not advance');
            const fresh=p.filter(x=>cmp(x.id,run.lower)>0 && cmp(x.id,run.upper)<=0);
            const part=await this.disk.commit(s,fresh,oldest);
            this.added+=fresh.length;
            if(part && this.files)await this.fillPart(s,part,false);
            if(cmp(oldest,run.lower)<=0) {await this.api.validateChannel(s.id,this.signal);await this.finish(s);}
        }
    }
    async finish(s) {
        check(this.signal);
        s.completeThrough=s.run.upper;s.checkedAt=now();s.historyComplete=true;s.run=null;
        await this.disk.saveState(s);
    }
    async repairFiles(s) {
        // Only incomplete parts, not the entire historical archive.
        const pending=s.parts.filter(p=>p.pending>0);
        for(const p of pending){check(this.signal);await this.fillPart(s,p,true);}
    }
    async fillPart(s,p,refresh) {
        if(!p.pending)return;
        const data=await this.disk.readPart(p);
        let dirty=false,previewBudget=2*1024*1024;
        for(const m of data.messages) {
            check(this.signal);
            const pending=(m.attachments||[]).filter(a=>a._archive?.status!=='saved' && !this.attemptedFiles.has(s.id+':'+m.id+':'+a.id));
            if(!pending.length)continue;
            let fresh=null;
            if(refresh) {
                try{fresh=await this.api.message(s.id,m.id,this.signal);}
                catch(e){if(e.name==='AbortError'||isDiskError(e)||e.status===401||e.fatal)throw e;}
            }
            for(const a of pending) {
                check(this.signal); this.attemptedFiles.add(s.id+':'+m.id+':'+a.id); dirty=true;
                const freshA=fresh?.attachments?.find(x=>String(x.id)===String(a.id));
                if(freshA?.url)a.url=freshA.url;
                const rel=`files/${s.id}/${id(m.id)}/${id(a.id)}-${safeName(a.filename)}`;
                this.emit(s,'files',{filename:String(a.filename||a.id)});
                try {
                    const result=await this.download(a,this.disk.resolve(rel),this.signal);
                    a._archive={status:'saved',path:rel,bytes:result.bytes,sha256:result.sha256,savedAt:now()};
                    this.filesSaved++;
                    const isText=/\.(txt|md|markdown|js|jsx|ts|tsx|json|py|css|html?|csv|ya?ml|xml|log|bat|ps1|ini|toml|c|cpp|h|rs|java|sql|sh)$/i.test(a.filename||'') || /^text\//i.test(a.content_type||'');
                    if(isText && result.bytes<=512*1024 && result.bytes<=previewBudget) {
                        const b=await fsp.readFile(this.disk.resolve(rel));
                        let text=b[0]===0xff && b[1]===0xfe?b.subarray(2).toString('utf16le'):b.toString('utf8');
                        if(!text.includes('\0')) {a._archive.text=text;a._archive.preview='full';previewBudget-=result.bytes;}
                    }
                } catch(e) {
                    if(e.name==='AbortError' || isDiskError(e)) {
                        if(dirty)await this.disk.updatePart(s,p,data.messages);
                        throw e;
                    }
                    a._archive={status:'failed',error:String(e.message||e),lastAttempt:now()};
                }
            }
        }
        if(dirty)await this.disk.updatePart(s,p,data.messages);
    }
}
function isDiskError(e) {return ['ENOSPC','EACCES','EPERM','EROFS','EMFILE','EIO','ENAMETOOLONG'].includes(e?.code);}
function validateCDN(url) {
    const u=new URL(url);
    if(u.protocol!=='https:' || u.username || u.password || (u.port && u.port!=='443') || !['cdn.discordapp.com','media.discordapp.net','cdn.discord.com'].includes(u.hostname))throw new Error('The attachment uses an unsupported domain — external URLs are not downloaded automatically');
    return u;
}
async function downloadAttachment(a,target,signal,options={}) {
    check(signal);validateCDN(a.url);
    const expected=Number(a.size);
    const fetcher=options.fetch || globalThis.BdApi?.Net?.fetch?.bind(globalThis.BdApi.Net);
    if(typeof fetcher!=='function')throw new Error('BetterDiscord does not expose BdApi.Net.fetch — messages can be saved, but attachments cannot be downloaded yet');
    await fsp.mkdir(path.dirname(target),{recursive:true});
    // Reuse only small completed files: the bridge cannot stream-read a local
    // large file. Large orphaned files are re-downloaded instead of filling RAM.
    const existing=await fsp.stat(target).catch(()=>null);
    if(existing && expected>=0 && existing.size===expected && existing.size<=512*1024) {
        const data=await fsp.readFile(target);
        return {bytes:data.length,sha256:digest(data)};
    }
    const tmp=target+'.partial';
    const controller=new AbortController();
    const cancel=()=>controller.abort(abortError());
    signal?.addEventListener('abort',cancel,{once:true});
    const timeoutMs=options.timeoutMs ?? 30000;
    let url=a.url,redirects=0,reader=null;
    const wait=(promise)=>new Promise((resolve,reject)=>{
        let done=false;
        const finish=(fn,value)=>{if(done)return;done=true;clearTimeout(timer);controller.signal.removeEventListener('abort',aborted);fn(value);};
        const aborted=()=>finish(reject,controller.signal.reason || abortError());
        const timer=setTimeout(()=>{const e=new Error('Attachment did not respond within '+Math.round(timeoutMs/1000)+' seconds');finish(reject,e);controller.abort(e);},timeoutMs);
        controller.signal.addEventListener('abort',aborted,{once:true});
        if(controller.signal.aborted)aborted();
        Promise.resolve(promise).then(value=>finish(resolve,value),error=>finish(reject,error));
    });
    try {
        check(signal);
        while(true) {
            const u=validateCDN(url);check(signal);
            const res=await wait(fetcher(u.href,{method:'GET',redirect:'manual',maxRedirects:0,
                signal:controller.signal,timeout:timeoutMs,headers:{'Accept-Encoding':'identity'}}));
            if([301,302,303,307,308].includes(res.status)) {
                void res.body?.cancel().catch(()=>{});
                const next=res.headers?.get('location');
                if(++redirects>4 || !next)throw new Error('The attachment redirected too many times');
                url=new URL(next,u).href;continue;
            }
            if(res.status!==200) {void res.body?.cancel().catch(()=>{});throw new Error(`Failed to download attachment: HTTP ${res.status}`);}
            if(!res.body?.getReader)throw new Error('BetterDiscord did not return an attachment stream — the file will not be marked as saved');
            reader=res.body.getReader();
            const hash=crypto.createHash('sha256');let bytes=0;
            await fsp.writeFile(tmp,Buffer.alloc(0),{flag:'w',mode:0o600});
            while(true) {
                const chunk=await wait(reader.read());check(signal);if(chunk.done)break;
                const data=Buffer.from(chunk.value);
                bytes+=data.length;
                if(Number.isFinite(expected) && expected>=0 && bytes>expected)throw new Error(`File size mismatch (${bytes}/${expected} bytes)`);
                hash.update(data);
                // Bounded per-chunk writes; no Node stream/pipeline dependency.
                await fsp.writeFile(tmp,data,{flag:'a',mode:0o600});
                await sleep(0,signal); // Let Discord's UI and the stop button run.
            }
            check(signal);
            if(Number.isFinite(expected) && expected>=0 && bytes!==expected)throw new Error(`File size mismatch (${bytes}/${expected} bytes)`);
            await fsp.writeFile(tmp,Buffer.alloc(0),{flag:'a',mode:0o600,flush:true});
            await fsp.rename(tmp,target);
            return {bytes,sha256:hash.digest('hex')};
        }
    } catch(e) {
        controller.abort(e);await fsp.unlink(tmp).catch(()=>{});
        if(signal?.aborted)throw abortError();throw e;
    } finally {
        signal?.removeEventListener('abort',cancel);
        if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch(_){}}
    }
}

module.exports={VERSION,DiskArchive,HistoryEngine,atomicWrite,readJSON,encodePart,decodePart,safeJSON,safeName,id,cmp,check,sleep,abortError,digest,isDiskError,downloadAttachment,validateCDN,page,channelSummary,now};

},
"./discord":function(module,exports,require){
'use strict';
// The ONLY module aware of Discord internals. No token extraction, no DOM scraping.
// Read-only HTTP GET calls through Discord's own loaded HTTP module.
const {id,cmp,sleep,check,abortError} = require('./core');
const ROOT_TYPES = new Set([0,2,5,13,15,16]);
const THREAD_PARENTS = new Set([0,5,15,16]);
const CONTAINERS = new Set([15,16]);
const SNOWFLAKE = /^[1-9]\d{0,21}$/;

// Discord's REST wrapper is an OBJECT accepting get({url, query, retries}).
// The underlying SuperAgent export is a FUNCTION with the very same HTTP
// method names, but accepts get(url, data). 0.1.2 could select that function.
// Never probe low-level clients, extract credentials, or fall back to raw XHR.
const HTTP_METHODS = ['get','post','put','patch','del'];
function isDiscordHTTP(m) {
    if(!m || typeof m!=='object' || Array.isArray(m))return false;
    if(!HTTP_METHODS.every(k=>typeof m[k]==='function'))return false;
    // Also reject a namespace/object re-exporting a generic request library.
    return !['Request','Response','getXHR','serializeObject'].some(k=>typeof m[k]==='function');
}
function valueType(v) {return v===null?'null':Array.isArray(v)?'array':typeof v;}
function headerValue(response,name) {
    const headers=response?.headers||response?.header;
    if(!headers)return undefined;
    if(typeof headers.get==='function')return headers.get(name)??undefined;
    const key=Object.keys(headers).find(k=>k.toLowerCase()===name.toLowerCase());
    return key===undefined?undefined:headers[key];
}
function responseInfo(response) {
    const raw=response?.body;
    const text=typeof response?.text==='string'?response.text:null;
    const mime=String(headerValue(response,'content-type')||response?.type||'').split(';',1)[0].trim().toLowerCase();
    // Only a MIME token is recorded, never arbitrary headers or body snippets.
    const contentType=/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)&&mime.length<=100?mime:'unknown';
    const candidate=typeof raw==='string'?raw:raw==null?text:null;
    const looksLikeHtml=contentType==='text/html'||contentType==='application/xhtml+xml'||(candidate!==null&&/^\s*</.test(candidate));
    let body=raw,source=raw==null?'none':'body',reason=null;
    if(looksLikeHtml)reason='DA_HTTP_NOT_JSON';
    else if(candidate!==null) {
        if(!candidate.trim()) {body=null;reason='DA_HTTP_BODY_NULL';}
        else {
            try {body=JSON.parse(candidate);source=typeof raw==='string'?'body-json':'text-json';}
            catch(_) {reason='DA_HTTP_INVALID_JSON';} // Parser errors may contain private message text.
        }
    }
    if(!reason && body==null)reason='DA_HTTP_BODY_NULL';
    if(!reason && typeof body!=='object')reason='DA_HTTP_NOT_JSON';
    // Routing clues only; do not record URLs with tokens, query values, or bodies.
    let responseRoute='unknown';
    const finalURL=response?.xhr?.responseURL??response?.url;
    if(typeof finalURL==='string') {
        try {const u=new URL(finalURL);responseRoute=/^\/api(?:\/|$)/.test(u.pathname)?'api':'non-api';}catch(_){}
    }
    const meta={bodyType:valueType(raw),contentType,textLength:text?.length??0,
        looksLikeHtml,jsonSource:source,decodedBodyType:valueType(body),responseRoute,
        requestUrlType:valueType(response?.req?.url),...(Array.isArray(body)?{items:body.length}:{})};
    return {body,reason,meta};
}
function payloadError(code,status) {
    const message=code==='DA_HTTP_BODY_NULL'
        ?'The HTTP bridge reported success but returned no JSON data (body: null/empty) — channels or history have not been loaded yet'
        :code==='DA_HTTP_INVALID_JSON'
        ?'The HTTP bridge returned text that could not be parsed as JSON — stopping to avoid skipping data'
        :'The HTTP bridge returned a web page or non-JSON content instead of Discord API JSON — this is not treated as an empty result';
    return Object.assign(new Error(message),{code,status,fatal:true});
}
function ownerState(guildStore,userStore,gid,expectedUserId=null) {
    const state={source:'GuildStore/UserStore',status:'unknown',guildId:String(gid),userId:null,ownerId:null};
    let g,u;
    try {g=guildStore?.getGuild?.(String(gid));u=userStore?.getCurrentUser?.();}
    catch(_) {return {...state,status:'store_unavailable'};}
    if(!u || !SNOWFLAKE.test(String(u.id)))return {...state,status:'user_unavailable'};
    state.userId=String(u.id);
    if(expectedUserId && state.userId!==expectedUserId)return {...state,status:'account_changed'};
    if(!g || String(g.id)!==String(gid) || g.unavailable===true)return {...state,status:'guild_unavailable'};
    const owner=g.ownerId??g.owner_id;
    if(!SNOWFLAKE.test(String(owner)))return {...state,status:'owner_unavailable'};
    state.ownerId=String(owner);
    return {...state,status:state.ownerId===state.userId?'owner':'not_owner'};
}
function ownerError(state) {
    const messages={
        user_unavailable:'No logged-in user was found — make sure Discord is connected, then try again',
        account_changed:'The Discord account changed during the job — close this window and reopen it to verify server ownership',
        guild_unavailable:'Server data is not ready yet — open this server in Discord and click Reload Channel List',
        owner_unavailable:'Owner information is not ready yet — this does not mean you do not have access',
        store_unavailable:'Failed to read user or server data from Discord',
        not_owner:'Backups are only available for servers owned by the current account'
    };
    return Object.assign(new Error(messages[state.status]||'Server ownership could not be verified yet'),{code:'DA_'+state.status.toUpperCase(),fatal:true});
}
function withTimeout(promise,ms,signal) {
    check(signal);
    return new Promise((resolve,reject)=>{
        const stop=()=>finish(reject,abortError());
        const timer=setTimeout(()=>{const e=new Error('Discord did not respond within 45 seconds — the resume point has been saved');e.timeout=true;finish(reject,e);},ms);
        function finish(fn,v){clearTimeout(timer);signal?.removeEventListener('abort',stop);fn(v);}
        signal?.addEventListener('abort',stop,{once:true});
        Promise.resolve(promise).then(v=>finish(resolve,v),e=>finish(reject,e));
    });
}
class DiscordClient {
    constructor(BdApi,{onStatus=()=>{},gap=400}={}) {
        this.bd=BdApi;this.onStatus=onStatus;this.gap=gap;this.nextAt=0;this.queue=Promise.resolve();this.history=[];
        const W=BdApi.Webpack;
        this.userStore=W.getStore('UserStore'); this.guildStore=W.getStore('GuildStore');
        this.boundUserId=null;this.ownership=null;this.channelSource=null;
        this.http=W.getModule(isDiscordHTTP,{searchExports:true});this.jsonReceived=false;
        if(!this.userStore?.getCurrentUser || !this.guildStore?.getGuild)throw new Error('Required Discord modules (UserStore / GuildStore) were not found. This Discord build may be incompatible, so no backup has started');
        if(!isDiscordHTTP(this.http))throw Object.assign(new Error('No supported Discord REST module was found — low-level HTTP libraries are not used as substitutes. Make sure Discord is ready, then reopen the backup window'),{code:'DA_HTTP_MODULE_NOT_FOUND',fatal:true});
    }
    diagnostics() {
        const live=this.guildId?ownerState(this.guildStore,this.userStore,this.guildId,this.boundUserId):this.ownership;
        // No user IDs, owner IDs, tokens, message contents or response bodies.
        return {plugin:'DiscordArchive',betterDiscord:String(this.bd.version||'unknown'),
            userStore:!!this.userStore,guildStore:!!this.guildStore,http:!!this.http,
            httpModule:{type:typeof this.http,selector:'rest-object-only',jsonReceived:this.jsonReceived},
            ownership:live?{source:live.source,status:live.status}:null,
            channelSource:this.channelSource,requests:this.history.slice(-100)};
    }
    owns(gid) {return ownerState(this.guildStore,this.userStore,gid,this.boundUserId).status==='owner';}
    requireOwner(gid) {
        const state=ownerState(this.guildStore,this.userStore,gid,this.boundUserId);this.ownership=state;
        if(state.status!=='owner')throw ownerError(state);
        return state;
    }
    async assertOwner(gid,signal) {
        check(signal);gid=id(gid);
        const state=this.requireOwner(gid);
        // Use the same live Discord stores as the guild menu. The extra GET
        // /guilds/:id in 0.1.1 wrongly gated selection on one REST payload shape.
        // This does not grant API permissions: channel/history reads stay authenticated.
        this.boundUserId=state.userId;this.guildId=gid;
        return this.guildStore.getGuild(gid);
    }
    get(url,query={},signal) {
        // UI probes and backup requests share one queue; never write to Discord.
        const task=()=>this.request(url,query,signal);
        const p=this.queue.then(task,task);this.queue=p.catch(()=>{});return p;
    }
    async request(url,query,signal) {
        if(!/^\/(guilds|channels)\/\d+(\/[^?#\s]*)?$/.test(url))throw new Error('Unsupported API path');
        let transient=0;
        for(let attempt=0;attempt<6;attempt++) {
            check(signal);if(this.guildId)this.requireOwner(this.guildId);
            await sleep(Math.max(0,this.nextAt-Date.now()),signal);check(signal);
            if(this.guildId)this.requireOwner(this.guildId);
            this.nextAt=Date.now()+this.gap;
            let response,err;const t=Date.now();
            try {response=await withTimeout(this.http.get({url,query,retries:0}),45000,signal);}
            catch(e){err=e;response=e?.response||e;}
            check(signal);if(this.guildId)this.requireOwner(this.guildId);
            const status=Number(response?.status??response?.statusCode??0);
            const {body,reason,meta}=responseInfo(response);
            const header=name=>headerValue(response,name);
            this.history.push({path:url,status,ms:Date.now()-t,at:new Date().toISOString(),...meta,
                ...(status>=200&&status<300&&reason?{errorCode:reason}:{})});
            if(this.history.length>150)this.history.shift();
            if(status>=200&&status<300&&!err) {
                const remaining=header('x-ratelimit-remaining'),reset=Number(header('x-ratelimit-reset-after'));
                if(String(remaining)==='0' && Number.isFinite(reset))this.nextAt=Math.max(this.nextAt,Date.now()+reset*1000+100);
                if(reason)throw payloadError(reason,status);
                this.jsonReceived=true;return body;
            }
            if(err?.name==='AbortError'||err?.timeout)throw err;
            if(status===429) {
                const seconds=Number(body?.retry_after??header('retry-after'));
                if(!Number.isFinite(seconds)||seconds<0)throw Object.assign(new Error('Discord rate-limited the request but did not provide a retry time — stop and resume later'),{status});
                this.nextAt=Math.max(this.nextAt,Date.now()+seconds*1000+250);
                this.onStatus(`Discord rate limit: waiting ${Math.ceil(seconds)} seconds`);continue;
            }
            if((status>=500 || status===0) && ++transient<=3) {
                const wait=1000*2**(transient-1);this.nextAt=Math.max(this.nextAt,Date.now()+wait);
                this.onStatus(`Connection issue: retrying in ${wait/1000} seconds`);continue;
            }
            let text=status===401?'Please sign in to Discord again':status===403?'You do not have permission to read this data':status===404?'The channel or message could not be found':`Discord returned an unexpected HTTP response ${status||'unknown'}`;
            throw Object.assign(new Error(text),{status});
        }
        throw new Error('Discord is continuously rate limiting requests — click Back Up again later to resume');
    }
    async channels(gid,signal) {
        await this.assertOwner(gid,signal);this.channelSource='Discord API';
        const a=await this.get(`/guilds/${id(gid)}/channels`,{},signal);
        if(!Array.isArray(a))throw Object.assign(new Error('Discord returned a channel list in an unsupported format — open Details and copy the status'),{code:'DA_CHANNEL_LIST_SHAPE'});
        if(a.some(c=>!c || !SNOWFLAKE.test(String(c.id)) || (c.guild_id!=null && String(c.guild_id)!==String(gid))))throw new Error('The channel list contains invalid IDs or channels from a different server');
        // Appearance metadata only. Preserve original room/category positions for
        // the offline reader; this uses the existing channel-list response.
        this.channelLayout=a.map(c=>({id:String(c.id),name:String(c.name||c.id),type:c.type,
            parentId:c.parent_id==null?null:String(c.parent_id),position:Number.isFinite(c.position)?c.position:null}));
        const cats=new Map(a.filter(c=>c.type===4).map(c=>[String(c.id),c.name]));
        return a.filter(c=>ROOT_TYPES.has(c.type)).map(c=>({...c,category:cats.get(String(c.parent_id))||''}));
    }
    async validateChannel(cid,signal) {
        if(!this.guildId)throw new Error('Server ownership has not been verified yet');
        this.requireOwner(this.guildId);
        const c=await this.get(`/channels/${id(cid)}`,{},signal);
        if(String(c?.id)!==String(cid) || String(c.guild_id)!==this.guildId)throw new Error('Failed to verify the selected channel in this server');
        // Owner has all channel permissions. Re-check owner before treating an empty page as the end.
        this.requireOwner(this.guildId);return c;
    }
    messages(cid,query,signal) {return this.get(`/channels/${id(cid)}/messages`,query,signal);}
    message(cid,mid,signal) {return this.get(`/channels/${id(cid)}/messages/${id(mid)}`,{},signal);}
    async discover(gid,selected,includeThreads,signal,onStatus=()=>{}) {
        const out=new Map(selected.filter(c=>!CONTAINERS.has(c.type)).map(c=>[String(c.id),c]));
        const warnings=[];
        const parents=selected.filter(c=>THREAD_PARENTS.has(c.type));
        if(!includeThreads) {
            for(const p of parents.filter(c=>CONTAINERS.has(c.type)))warnings.push(`#${p.name}: Forum posts were not backed up because Include Threads is turned off`);
            return {channels:[...out.values()],warnings};
        }
        const parentMap=new Map(parents.map(c=>[String(c.id),c]));
        const add=t=>{
            const p=parentMap.get(String(t.parent_id));
            if(p && [10,11,12].includes(t.type))out.set(String(t.id),{...t,category:[p.category,`#${p.name}`].filter(Boolean).join(' / ')});
        };
        if(parents.length) {
            try {
                onStatus('Looking for active threads');
                const a=await this.get(`/guilds/${id(gid)}/threads/active`,{},signal);
                if(!Array.isArray(a?.threads))throw new Error('Unsupported thread list format');a.threads.forEach(add);
            } catch(e) {if(e.name==='AbortError'||e.status===401||e.fatal)throw e;warnings.push(`Active threads: ${e.message}`);}
        }
        for(const p of parents)for(const kind of (p.type===0?['public','private']:['public'])) {
            let before=null;
            try {
                while(true) {
                    check(signal);onStatus(`Searching archived threads in #${p.name} (${kind})`);
                    const q={limit:100};if(before)q.before=before;
                    const a=await this.get(`/channels/${id(p.id)}/threads/archived/${kind}`,q,signal);
                    if(!Array.isArray(a?.threads)||typeof a.has_more!=='boolean')throw new Error('Unsupported archived thread list format');
                    a.threads.forEach(add);if(!a.has_more)break;
                    const dates=a.threads.map(t=>t.thread_metadata?.archive_timestamp).filter(Boolean).sort();
                    const next=dates[0];
                    if(!next || (before && new Date(next)>=new Date(before)))throw new Error('The thread list cursor did not advance — completeness cannot be confirmed');
                    before=next;
                }
            }catch(e){if(e.name==='AbortError'||e.status===401||e.fatal)throw e;warnings.push(`#${p.name} ${kind} threads: ${e.message}`);}
        }
        return {channels:[...out.values()],warnings};
    }
}
module.exports={DiscordClient,ROOT_TYPES,THREAD_PARENTS,CONTAINERS,withTimeout,ownerState,isDiscordHTTP,responseInfo};

},
"./assets":function(module,exports,require){
'use strict';
module.exports={"index.html":"<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'self' file:; style-src 'self' file: 'unsafe-inline'; img-src 'self' file: data:; media-src 'self' file:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'\">\n<title>Backup Data Discord Server — Offline Archive</title>\n<link rel=\"stylesheet\" href=\"viewer.css\">\n<script src=\"catalog.js\" defer></script>\n<script src=\"viewer.js\" defer></script>\n</head>\n<body>\n<div class=\"titlebar\"><span>Backup Data Discord Server <small id=\"reader-version\"></small></span><span class=\"offline-indicator\">● Offline · Local archive</span><button id=\"help-button\" class=\"title-help\" title=\"Usage & Data Scope\">Help</button></div>\n<div class=\"app-shell\">\n<nav class=\"server-rail\" aria-label=\"Server Archive\"><button id=\"server-icon\" class=\"server-icon\" title=\"Show / Hide Channel List\">DA</button><div class=\"rail-divider\"></div><button id=\"theme\" class=\"rail-tool\" title=\"Toggle Light / Dark Mode\" aria-label=\"Toggle Light / Dark Mode\">◐</button></nav>\n<aside class=\"channel-sidebar\" id=\"channel-sidebar\">\n<div class=\"server-head\"><h1 id=\"guild-name\">Opening archive…</h1><span title=\"Read-only archive\">⌄</span></div>\n<div class=\"channel-filter\"><label class=\"sr-only\" for=\"channel-filter\">Search channel names</label><input id=\"channel-filter\" type=\"search\" placeholder=\"Search channels\" autocomplete=\"off\"></div>\n<nav id=\"channel-list\" aria-label=\"Saved channels\"></nav>\n<div class=\"side-footer\"><span class=\"archive-symbol\">▣</span><div><strong>Local archive</strong><div id=\"archive-date\" class=\"muted\"></div></div><button id=\"archive-info\" title=\"Archive Details\" aria-label=\"Archive Details\">ⓘ</button></div>\n</aside>\n<main id=\"main\">\n<header class=\"channel-header\">\n<button id=\"toggle-channels\" class=\"mobile-toggle\" title=\"Channel List\" aria-label=\"Channel List\">☰</button>\n<div class=\"channel-heading\"><span class=\"hash\" aria-hidden=\"true\">#</span><h2 id=\"channel-title\">Choose a Channel</h2><span id=\"channel-topic\"></span></div>\n<div class=\"header-actions\"><button id=\"jump-toggle\" title=\"Jump to Date / Oldest / Latest\" aria-label=\"Jump to Date / Oldest / Latest\">▦</button><form id=\"search-form\"><label class=\"sr-only\" for=\"query\">Search messages</label><input id=\"query\" type=\"search\" placeholder=\"Search messages\" autocomplete=\"off\"><button type=\"submit\" aria-label=\"Search\" title=\"Search\">⌕</button></form></div>\n</header>\n<div id=\"jump-popover\" class=\"jump-popover\" hidden><label for=\"jump-date\">Jump to Date</label><input id=\"jump-date\" type=\"date\"><button id=\"first\">Oldest</button><button id=\"last\">Latest</button></div>\n<div id=\"global-warning\" class=\"warning\" hidden></div>\n<div class=\"content-columns\">\n<section class=\"chat-column\" aria-label=\"Message History\">\n<div id=\"chat-scroll\" class=\"chat-scroll\" tabindex=\"0\" aria-label=\"Scroll message history\">\n<div id=\"older-status\" class=\"history-edge\"></div>\n<div id=\"feed\" role=\"list\" aria-label=\"messages\"><div class=\"empty\">Choose a channel on the left to read saved messages</div></div>\n<div id=\"newer-status\" class=\"history-edge\"></div>\n</div>\n<button id=\"jump-latest\" class=\"jump-latest\" hidden>You are reading older history <strong>Jump to Latest ↓</strong></button>\n<div class=\"archive-footer\"><span id=\"channel-meta\">Read and copy only · does not send messages to Discord</span><button id=\"coverage\" class=\"coverage\" title=\"Status & Data Scope\">Local archive</button></div>\n</section>\n<section id=\"search-panel\" class=\"search-panel\" hidden aria-label=\"Search Results\">\n<div class=\"search-panel-head\"><strong>Search the Archive</strong><button id=\"search-clear\" aria-label=\"Close Search Results\" title=\"Close Search Results\">×</button></div>\n<div class=\"search-controls\"><label class=\"sr-only\" for=\"search-scope\">Search Scope</label><select id=\"search-scope\"><option value=\"channel\">This Channel</option><option value=\"all\">All Saved Channels</option></select><button id=\"search-stop\" hidden>Stop</button></div>\n<div id=\"search-status\" class=\"search-status\" role=\"status\"></div>\n<div id=\"search-results\" class=\"search-results\"></div><div id=\"result-nav\" class=\"result-nav\"></div>\n</section>\n</div>\n</main>\n</div>\n<div id=\"toast\" class=\"toast\" role=\"status\" hidden></div>\n<div id=\"message-menu\" class=\"message-menu\" hidden></div>\n<dialog id=\"detail-dialog\"><div class=\"dialog-heading\"><h2 id=\"detail-title\">Details</h2><button id=\"detail-close\" aria-label=\"Close Details\">×</button></div><div id=\"detail-content\"></div></dialog>\n<dialog id=\"media-dialog\" class=\"media-dialog\"><div class=\"dialog-heading\"><span id=\"media-name\"></span><button id=\"media-close\" aria-label=\"Close Image\">×</button></div><img id=\"media-image\" alt=\"\"><a id=\"media-download\" download>Save Original File</a></dialog>\n<dialog id=\"help\"><div class=\"dialog-heading\"><h2>Offline Archive</h2><button id=\"help-close\" aria-label=\"Close Help\">×</button></div>\n<p>Choose a channel on the left. Scroll up to read older history and down to continue. The reader loads more data from local files, does not contact Discord, and does not require page changes every 100 messages.</p>\n<p>Hover over a message to copy it, or right-click to open the menu. Consecutive messages from the same sender are grouped visually, but each message still keeps its own ID and copy button.</p>\n<p>Use the search box in the top right. Choose This Channel or All Saved Channels. Results appear on the right. Click “Go to Message” to view the original context. Use the date controls to jump to Oldest or Latest.</p>\n<p>Messages and attachments reflect the saved backup run. They are not live data, they do not recover messages deleted before backup, and they do not fully track every old edit.</p>\n<p>Images and attachments can only be opened when they were downloaded successfully. Profile pictures, emoji, stickers, and media from other websites are not loaded automatically. Unsaved profile pictures are shown as initials. This reader is not a full Discord clone.</p>\n<p>Channel order uses the saved layout data. Older archives without this data keep their existing order. Rebuild the reader from the plugin after loading the channel list to save the current order without downloading message history again.</p>\n<p>You can open <code>index.html</code> without signing in and without running a server. When moving the archive, copy the entire folder, not just the HTML file.</p>\n<p><strong>The archive is not encrypted. Do not publish the entire folder.</strong> Attachments may be unsafe just like the originals. Do not run files you do not trust. External links still require internet access when opened.</p>\n</dialog>\n<noscript>Please enable JavaScript to use the reader. Message data is stored in the channels folder.</noscript>\n</body>\n</html>\n","viewer.css":":root{color-scheme:dark;--rail:#1e1f22;--side:#2b2d31;--chat:#313338;--panel:#232428;--field:#1e1f22;--text:#dbdee1;--strong:#f2f3f5;--muted:#949ba4;--line:#3f4147;--hover:#2e3035;--active:#404249;--accent:#b7bfff;--brand:#5865f2;--link:#54b7f5;--code:#2b2d31;--quote:#4e5058;--warning:#f0b96a;--warning-bg:#443725;--selected:#3b3d53;--font: 'Segoe UI',Tahoma,Arial,sans-serif}\nbody.light{color-scheme:light;--rail:#e3e5e8;--side:#f2f3f5;--chat:#fff;--panel:#f2f3f5;--field:#e3e5e8;--text:#313338;--strong:#060607;--muted:#656c78;--line:#e3e5e8;--hover:#f5f6f7;--active:#dfe1e5;--accent:#4354b3;--brand:#5865f2;--link:#006aa8;--code:#f2f3f5;--quote:#aeb3bb;--warning:#805100;--warning-bg:#fff1d8;--selected:#eef0ff}\n*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{background:var(--chat);color:var(--text);font:16px/1.375 var(--font)}button,input,select{font:inherit;color:inherit}button{cursor:pointer;border:0;border-radius:5px;background:transparent;padding:6px 9px}button:hover{background:var(--active);color:var(--strong)}button:disabled{opacity:.45;cursor:default}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--brand);outline-offset:2px}input,select{background:var(--field);border:0;border-radius:4px;padding:6px 9px;min-width:0}a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}.muted{color:var(--muted);font-size:12px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}[hidden]{display:none!important}\n.titlebar{height:28px;background:var(--rail);display:flex;align-items:center;padding:0 13px;font-size:11px;font-weight:600;color:var(--muted);gap:20px;user-select:none}.offline-indicator{margin-left:auto;font-size:10px;font-weight:400}.title-help{font-size:11px;padding:2px 6px}.app-shell{display:grid;grid-template-columns:68px 242px minmax(0,1fr);height:calc(100vh - 28px);height:calc(100dvh - 28px)}.server-rail{display:flex;align-items:center;flex-direction:column;gap:10px;background:var(--rail);padding:12px 0}.server-icon{width:46px;height:46px;border-radius:15px;background:var(--brand);color:#fff!important;font-weight:650;font-size:17px;position:relative;overflow:visible}.server-icon:before{content:'';position:absolute;width:4px;height:33px;border-radius:0 3px 3px 0;left:-11px;top:7px;background:#fff}.server-icon:hover{background:var(--brand)}.rail-divider{height:2px;width:30px;background:var(--line);border-radius:2px}.rail-tool{width:44px;height:44px;border-radius:50%;font-size:26px;color:var(--muted)}.channel-sidebar{background:var(--side);display:flex;flex-direction:column;min-height:0;overflow:hidden}.server-head{height:49px;min-height:49px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;box-shadow:0 1px 0 #0003;color:var(--strong);gap:10px}.server-head h1{font-size:15px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0}.channel-filter{padding:14px 10px 5px}.channel-filter input{font-size:12px;width:100%;height:29px}#channel-list{overflow:auto;flex:1;padding:2px 8px 20px;scrollbar-width:thin;scrollbar-color:var(--field) transparent}.channel-category{margin-top:13px}.category{font-size:11px;font-weight:650;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:4px;width:100%;text-align:left;padding:5px 1px}.category:hover{background:transparent;color:var(--text)}.category-chevron{font-size:11px;width:12px;display:inline-block}.channel{display:flex;align-items:center;gap:7px;width:100%;text-align:left;color:var(--muted);font-size:15px;padding:6px 8px;margin:1px 0;min-height:34px}.channel.active{color:var(--strong);background:var(--active)}.channel-name{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;flex:1}.channel-symbol{font-size:21px;color:var(--muted);width:19px;flex-shrink:0;text-align:center;line-height:20px}.channel-count{font-size:10px;opacity:.6}.channel.thread{padding-left:29px;font-size:13px}.channel.thread .channel-symbol{font-size:15px}.channel-count.incomplete{color:var(--warning);opacity:1}.thread-parent{font-size:12px;color:var(--muted);padding:6px 10px 2px 17px}.side-footer{min-height:57px;display:flex;align-items:center;padding:8px 9px;background:var(--panel);gap:9px;font-size:12px}.side-footer>div{min-width:0;flex:1}.side-footer strong{color:var(--strong);font-size:12px}.side-footer .muted{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.archive-symbol{width:29px;height:29px;display:grid;place-items:center;border-radius:50%;background:var(--brand);color:#fff}.side-footer button{font-size:19px;color:var(--muted)}\nmain{position:relative;min-width:0;min-height:0;display:flex;flex-direction:column}.channel-header{height:49px;min-height:49px;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 16px;box-shadow:0 1px 0 #0003;z-index:3;background:var(--chat)}.channel-heading{display:flex;align-items:center;gap:9px;min-width:0}.hash{color:var(--muted);font-size:24px}.channel-heading h2{font-size:15px;color:var(--strong);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;max-width:190px}#channel-topic{margin-left:6px;border-left:1px solid var(--line);padding-left:14px;color:var(--muted);font-size:12px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.header-actions{display:flex;align-items:center;gap:10px;flex-shrink:0}.header-actions>button{color:var(--muted);font-size:23px;padding:3px 6px}#search-form{display:flex;align-items:center;width:200px;background:var(--field);border-radius:4px;height:26px}#query{font-size:12px;padding:3px 7px;flex:1;width:100%;height:26px}#search-form button{font-size:21px;color:var(--muted);padding:0 7px;line-height:26px}.jump-popover{position:absolute;top:51px;right:16px;background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:12px;z-index:30;box-shadow:0 5px 20px #0005;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;max-width:calc(100% - 20px)}.jump-popover button{background:var(--active)}.warning{background:var(--warning-bg);color:var(--warning);font-size:11px;padding:6px 16px;max-height:70px;overflow:auto;white-space:pre-wrap;flex-shrink:0}.content-columns{display:flex;flex:1;min-height:0;min-width:0}.chat-column{position:relative;flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}.chat-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--field) transparent;overflow-anchor:none;outline:none;padding-bottom:15px}.history-edge{text-align:center;color:var(--muted);font-size:12px;min-height:14px}.history-edge:not(:empty){padding:13px 16px}.history-edge button{color:var(--link);font-size:12px}.history-edge.error{color:var(--warning)}.empty{text-align:center;padding:70px 25px;color:var(--muted);font-size:14px;white-space:pre-wrap}#feed{padding-top:1px;min-width:0}.day-divider{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;color:var(--muted);margin:22px 16px 9px}.day-divider:before,.day-divider:after{content:'';height:1px;background:var(--line);flex:1}.day-divider.seam-hidden{display:none}.message{position:relative;padding:2px 36px 3px 72px;margin-top:17px;min-height:46px;overflow-wrap:anywhere;scroll-margin:35px 0;border:0;border-radius:0;background:transparent}.message:hover,.message:focus-within{background:var(--hover)}.message.grouped{margin-top:0;min-height:23px;padding-top:1px;padding-bottom:1px}.message.target{background:var(--selected);box-shadow:inset 3px 0 var(--brand)}.msg-header{display:flex;align-items:baseline;gap:8px;line-height:22px;margin:0}.author{color:var(--strong);font-size:15px;font-weight:600}.timestamp{font-size:11px;color:var(--muted);font-weight:400}.avatar{position:absolute;width:40px;height:40px;top:3px;left:16px;border-radius:50%;display:grid;place-items:center;font-size:14px;font-weight:650;color:#fff;background:var(--brand);overflow:hidden;user-select:none}.avatar.hue-1{background:#426e8a}.avatar.hue-2{background:#7a589b}.avatar.hue-3{background:#427867}.avatar.hue-4{background:#996a45}.avatar.hue-5{background:#855768}.compact-time{display:none;position:absolute;left:5px;top:3px;width:61px;text-align:center;font-size:10px;line-height:18px;color:var(--muted)}.message.grouped>.avatar,.message.grouped>.msg-header{display:none}.message.grouped:hover>.compact-time,.message.grouped:focus-within>.compact-time{display:block}.message.grouped>.reply{display:none}.message.system{min-height:28px;margin-top:9px;color:var(--muted);font-size:13px}.system-symbol{position:absolute;left:30px;top:3px;font-size:17px}.message-actions{display:flex;position:absolute;top:-16px;right:16px;background:var(--chat);box-shadow:0 0 0 1px var(--line),0 3px 7px #0003;border-radius:5px;opacity:0;pointer-events:none;z-index:2;overflow:hidden}.message:hover .message-actions,.message:focus-within .message-actions{opacity:1;pointer-events:auto}.message-actions button{font-size:12px;padding:6px 9px;border-radius:0;color:var(--muted)}.message-actions button:hover{color:var(--strong)}.message-body{font-size:16px;line-height:1.45}.text{white-space:pre-wrap}.text:empty{display:none}.message-body h1,.message-body h2,.message-body h3{color:var(--strong);line-height:1.3;margin:9px 0 4px;font-weight:700}.message-body h1{font-size:24px}.message-body h2{font-size:20px}.message-body h3{font-size:16px}.message-body blockquote{margin:3px 0;padding:0 0 0 12px;border-left:4px solid var(--quote);white-space:pre-wrap}.message-body ul,.message-body ol{padding-left:23px;margin:3px 0}.message-body li{padding-left:0;white-space:pre-wrap}.message-body .subtext{font-size:12px;color:var(--muted)}.message-body code.inline{font:85%/1.45 Consolas,'Cascadia Code',monospace;background:var(--code);padding:2px 4px;border-radius:3px;white-space:pre-wrap}.mention{background:#5865f24d;color:var(--accent);padding:0 2px;border-radius:3px}.spoiler{color:transparent;background:var(--field);border-radius:3px;cursor:pointer;padding:0 2px}.spoiler.revealed{color:inherit;background:var(--active)}.edited{font-size:10px;color:var(--muted);margin-left:5px}.reply{display:block;position:relative;border-radius:0;padding:0 0 3px 0;width:100%;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted);font-size:12px;line-height:18px}.reply:before{content:'↪';padding-right:8px}.reply:hover{background:transparent;color:var(--text)}.reply strong{font-weight:550;padding-right:6px}.code-block{position:relative;max-width:100%;border:1px solid var(--field);background:var(--code);border-radius:4px;margin:5px 0 3px;overflow:hidden}.code-block pre{margin:0;padding:8px;overflow:auto;white-space:pre;font:13px/1.4 Consolas,'Cascadia Code',monospace;tab-size:4;user-select:text}.code-block.wrap pre{white-space:pre-wrap;overflow-wrap:anywhere}.code-controls{position:absolute;right:4px;top:3px;display:flex;align-items:center;gap:3px;background:var(--code);border-radius:3px;opacity:0;z-index:1}.code-block:hover .code-controls,.code-block:focus-within .code-controls{opacity:1}.code-controls button{font-size:10px;color:var(--muted);padding:3px 6px}.code-language{font-size:10px;color:var(--muted);padding-left:5px}.tok-keyword{color:#c58de7}.tok-string{color:#a4cc88}.tok-comment{color:#89919a}.tok-number{color:#e8b57d}body.light .tok-keyword{color:#803db2}body.light .tok-string{color:#377348}body.light .tok-comment{color:#727986}body.light .tok-number{color:#906111}\n.attachment{margin-top:6px;max-width:560px}.file-box{background:var(--code);border:1px solid var(--field);border-radius:5px;padding:11px;display:flex;align-items:center;gap:10px}.file-icon{font-size:25px;color:var(--muted)}.file-info{min-width:0;flex:1;font-size:13px}.file-info strong{font-weight:500;color:var(--link);overflow-wrap:anywhere}.file-info small{font-size:11px;color:var(--muted);display:block}.file-box>a{font-size:20px;color:var(--muted)}.text-attachment{border:1px solid var(--field);border-radius:4px;background:var(--code);overflow:hidden}.text-attachment pre{margin:0;padding:10px;overflow:auto;white-space:pre;font:13px/1.4 Consolas,'Cascadia Code',monospace;tab-size:4}.text-attachment.collapsed pre{max-height:calc(6 * 18.2px + 20px);overflow:hidden}.attachment-footer{display:flex;align-items:center;gap:8px;border-top:1px solid var(--field);padding:7px 8px;min-height:44px;font-size:11px}.attachment-footer .file-info{font-size:12px;flex:1}.attachment-footer button{font-size:11px;color:var(--muted);padding:4px 7px}.attachment-footer a{font-size:19px;color:var(--muted)}.image-attachment{width:fit-content;position:relative}.image-button{padding:0;display:block;max-width:100%;background:transparent!important;border-radius:4px;overflow:hidden}.image-button img{display:block;max-width:100%;max-height:350px;object-fit:contain;border-radius:4px}.image-attachment .image-caption{display:none;font-size:10px;margin-top:3px;color:var(--muted)}.image-attachment:focus-within .image-caption,.image-attachment:hover .image-caption{display:block}.attachment video{display:block;max-width:100%;max-height:350px;border-radius:5px}.attachment audio{display:block;width:360px;max-width:100%}.file-error{font-size:12px;color:var(--warning);padding:7px 9px;border-left:3px solid var(--warning);background:var(--warning-bg);margin-top:4px;white-space:pre-wrap}.embed{margin:6px 0;max-width:520px;border-left:4px solid var(--brand);border-radius:4px;background:var(--code);padding:9px 13px;font-size:14px}.embed p{white-space:pre-wrap;margin:4px 0}.embed-field{margin:6px 0}.reactions{display:flex;gap:5px;margin-top:5px;flex-wrap:wrap}.reaction{font-size:12px;background:var(--code);border:1px solid var(--line);border-radius:6px;padding:2px 7px}.archive-footer{height:39px;min-height:39px;display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 16px 10px;padding:0 10px;background:var(--side);border-radius:6px;font-size:11px;color:var(--muted)}#channel-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coverage{font-size:10px;white-space:nowrap;flex-shrink:0;color:var(--muted)}.coverage.incomplete{color:var(--warning)}.jump-latest{position:absolute;bottom:54px;left:16px;right:16px;background:var(--panel);color:var(--muted);box-shadow:0 2px 6px #0004;font-size:11px;text-align:left;display:flex;justify-content:space-between;z-index:4}.jump-latest strong{color:var(--text)}\n.search-panel{width:330px;min-width:270px;max-width:40%;background:var(--side);display:flex;flex-direction:column;border-left:1px solid var(--line)}.search-panel-head{min-height:49px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;background:var(--panel);font-size:14px;color:var(--strong)}.search-panel-head button{font-size:24px;color:var(--muted)}.search-controls{padding:10px 12px 4px;display:flex;align-items:center;gap:8px;font-size:12px}.search-controls select{flex:1}.search-controls button{font-size:11px;color:var(--warning)}.search-status{padding:7px 14px;font-size:11px;color:var(--muted);white-space:pre-wrap}.search-results{padding:0 12px;overflow:auto;flex:1;scrollbar-width:thin}.search-hit{border-radius:5px;background:var(--chat);border:1px solid var(--line);padding:12px;margin:0 0 9px;font-size:13px;overflow-wrap:anywhere}.search-hit strong{font-size:12px;color:var(--muted)}.search-hit p{white-space:pre-wrap;margin:8px 0}.search-hit button{font-size:11px;color:var(--link);padding:3px 0}.result-nav{display:flex;justify-content:center;align-items:center;gap:4px;padding:8px;font-size:11px}.result-nav button{font-size:12px}.message-menu{position:fixed;z-index:70;min-width:175px;padding:6px;background:var(--field);border:1px solid var(--line);border-radius:5px;box-shadow:0 4px 15px #0006}.message-menu button{display:block;width:100%;text-align:left;font-size:13px;padding:8px}.message-menu button:hover{background:var(--brand);color:#fff}.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);max-width:90vw;z-index:200;background:var(--field);color:var(--strong);padding:10px 18px;border:1px solid var(--line);border-radius:6px;box-shadow:0 3px 12px #0004;font-size:13px}dialog{background:var(--chat);color:var(--text);border:1px solid var(--line);border-radius:9px;max-width:700px;width:calc(100vw - 32px);max-height:90vh;padding:20px;overflow:auto;font-size:14px}dialog::backdrop{background:#000b}.dialog-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.dialog-heading h2{margin:0;font-size:18px;color:var(--strong)}.dialog-heading button{font-size:24px;line-height:24px;color:var(--muted)}dialog p{line-height:1.65}dialog pre{font:12px/1.5 Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--code);padding:12px;max-height:60vh;overflow:auto}dialog textarea{width:100%;height:280px;font:13px/1.5 Consolas,monospace;background:var(--code);color:var(--text);border:1px solid var(--line);padding:10px}.media-dialog{width:auto;max-width:94vw;background:var(--panel)}.media-dialog img{display:block;max-width:85vw;max-height:73vh;object-fit:contain}.media-dialog a{display:inline-block;font-size:12px;margin-top:10px}.mobile-toggle{display:none}.sidebar-hidden .app-shell{grid-template-columns:68px minmax(0,1fr)}.sidebar-hidden .channel-sidebar{display:none}\n@media(max-width:1100px){#channel-topic{display:none}.search-panel{width:300px}.app-shell{grid-template-columns:60px 210px minmax(0,1fr)}.server-icon:before{left:-7px}.channel-header{padding:0 12px;gap:8px}#search-form{width:170px}.message{padding-right:18px}.header-actions{gap:4px}}\n@media(max-width:820px){.search-panel{position:absolute;right:0;top:49px;bottom:0;z-index:10;max-width:100%;width:330px;box-shadow:-6px 0 20px #0004}.app-shell{grid-template-columns:52px 185px minmax(0,1fr)}.server-icon{width:38px;height:38px}.server-icon:before{left:-7px;top:3px}.channel-heading h2{max-width:120px}.message{padding-left:60px}.avatar{left:12px;width:36px;height:36px}.compact-time{width:51px;left:3px}.header-actions>button{font-size:20px}.offline-indicator{display:none}#search-form{width:140px}}\n@media(max-width:620px){.app-shell,.sidebar-hidden .app-shell{grid-template-columns:minmax(0,1fr)}.server-rail{display:none}.channel-sidebar{display:none;position:absolute;top:28px;bottom:0;left:0;width:245px;z-index:40;box-shadow:6px 0 20px #0006}.sidebar-open .channel-sidebar{display:flex}.mobile-toggle{display:block;font-size:18px;padding:3px}.channel-header{gap:5px;padding:0 8px}.channel-heading{gap:4px;flex:1}.channel-heading h2{max-width:110px;font-size:14px}.header-actions{gap:2px}#search-form{width:130px}.message{padding-right:12px;margin-top:14px}.message-actions{right:5px}.message.grouped{margin-top:0}.archive-footer{margin:0 8px 8px}.message-body{font-size:15px}.code-controls{position:static;opacity:1;justify-content:flex-end;border-bottom:1px solid var(--line)}.search-panel{width:100%;max-width:100%;min-width:0;top:49px}.message-menu{max-width:95vw}.coverage{max-width:125px;overflow:hidden;text-overflow:ellipsis}}\n@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}\n\n.message:has(>.reply)>.avatar{top:24px}\n","viewer.js":"'use strict';\n// Standalone reader: local classic scripts only. No Discord runtime, remote CSS,\n// eval of message text, fetch(), server, or database is needed to read an archive.\n(() => {\nconst READER_VERSION = '0.1.6';\nconst $=id=>document.getElementById(id);\nconst catalog=window.DiscordArchiveCatalog;\nconst feed=$('feed'),scroll=$('chat-scroll');\nconst ID=/^\\d{1,22}$/;\nconst PART=/^channels\\/\\d{1,22}\\/parts\\/\\d{1,22}-\\d{1,22}\\.js$/;\nconst MAX_PARTS=5;\nconst cmp=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;\nconst el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;};\nconst btn=(text,fn,cls='')=>{const n=el('button',cls,text);n.type='button';n.addEventListener('click',fn);return n;};\nconst number=n=>Number(n||0).toLocaleString('en-US');\nconst bytes=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':n>=1024?(n/1024).toFixed(1)+' KB':n+' B';\nconst stamp=(t,options={dateStyle:'medium',timeStyle:'short'})=>{try{return new Intl.DateTimeFormat('en-US',options).format(new Date(t));}catch(_){return String(t||'Unknown time');}};\nconst day=t=>stamp(t,{dateStyle:'long'});\nconst textName=m=>m.member?.nick||m.author?.global_name||m.author?.username||'Unknown sender';\nlet active=null,first=0,last=-1,generation=0,loading=false,loadError=null,searchGeneration=0,searching=false;\nlet resultPage=0,totalHits=0,results=[],noticeTimer,scrollFrame=0;\nconst blocks=new Map(),positions=new Map(),partCache=new Map(),collapsed=new Set();\nconst key='DiscordArchive:'+String(catalog?.guild?.id||'unknown');\nfunction toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('toast').hidden=true,2600);}\nfunction showDialog(title,...nodes){$('detail-title').textContent=title;$('detail-content').replaceChildren(...nodes);if(!$('detail-dialog').open)$('detail-dialog').showModal();}\nasync function copyText(text){\n    text=String(text??'');\n    try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);toast('Copied');return;}}catch(_){}\n    const t=el('textarea');t.value=text;t.style.cssText='position:fixed;left:-9999px;top:0';document.body.append(t);t.select();\n    let ok=false;try{ok=document.execCommand('copy');}catch(_){}t.remove();\n    if(ok){toast('Copied');return;}\n    const box=el('textarea');box.value=text;showDialog('Copy Message',el('p','', 'Your browser blocked automatic copying. Press Ctrl+C to copy the selected text.'),box);box.focus();box.select();\n}\nfunction localFile(p){\n    if(typeof p!=='string'||!/^files\\/\\d{1,22}\\/\\d{1,22}\\/\\d{1,22}-[^/\\\\]+$/.test(p)||p.includes('/../'))return null;\n    return p.split('/').map(encodeURIComponent).join('/');\n}\nfunction link(url,label){\n    try{const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return el('span','',label||url);\n        const n=el('a','',label||url);n.href=u.href;n.target='_blank';n.rel='noopener noreferrer';n.title=u.href+' — External link; requires internet access';return n;\n    }catch(_){return el('span','',label||url);}\n}\n// Render text into DOM nodes, never innerHTML. Unsupported syntax is kept as text.\nfunction inline(parent,value,m={},depth=0){\n    const text=String(value||'');if(depth>6){parent.append(document.createTextNode(text));return;}\n    const re=/\\\\[\\\\`*_~|\\[\\]()<>#>]|`[^`\\n]+`|\\[[^\\]\\n]+\\]\\(https?:\\/\\/[^\\s]+?\\)|<https?:\\/\\/[^>\\s]+>|https?:\\/\\/[^\\s<>]+|<@!?\\d+>|<@&\\d+>|<#\\d+>|<a?:[\\w]+:\\d+>|\\*\\*\\*[^\\n]+?\\*\\*\\*|\\*\\*[^\\n]+?\\*\\*|__[^\\n]+?__|~~[^\\n]+?~~|\\|\\|[^\\n]+?\\|\\||\\*[^*\\n]+?\\*|_[^_\\n]+?_/g;\n    let lastIndex=0,match;\n    while((match=re.exec(text))){\n        parent.append(document.createTextNode(text.slice(lastIndex,match.index)));const v=match[0];\n        if(v[0]==='\\\\')parent.append(document.createTextNode(v.slice(1)));\n        else if(v[0]==='`')parent.append(el('code','inline',v.slice(1,-1)));\n        else if(v[0]==='['){const i=v.indexOf('](');parent.append(link(v.slice(i+2,-1),v.slice(1,i)));}\n        else if(v.startsWith('<http'))parent.append(link(v.slice(1,-1)));\n        else if(v.startsWith('http')){\n            let url=v,tail='';while(/[.,!?;:]$/.test(url)){tail=url.slice(-1)+tail;url=url.slice(0,-1);}\n            while(url.endsWith(')')&&(url.match(/\\)/g)||[]).length>(url.match(/\\(/g)||[]).length){url=url.slice(0,-1);tail=')'+tail;}\n            parent.append(link(url));if(tail)parent.append(document.createTextNode(tail));\n        }else if(v.startsWith('<@&'))parent.append(el('span','mention','@role-'+v.replace(/\\D/g,'')));\n        else if(v.startsWith('<@')){const uid=v.replace(/\\D/g,'');const u=(m.mentions||[]).find(x=>String(x.id)===uid);parent.append(el('span','mention','@'+(u?.global_name||u?.username||uid)));}\n        else if(v.startsWith('<#')){const cid=v.replace(/\\D/g,'');const c=catalog.channels.find(x=>String(x.id)===cid);const n=c?btn('#'+c.name,()=>selectChannel(cid),'mention'):el('span','mention','#'+cid);parent.append(n);}\n        else if(/^<a?:/.test(v))parent.append(el('span','',':'+v.split(':')[1]+':'));\n        else {\n            let n,inside;\n            if(v.startsWith('***')){n=el('strong');const em=el('em');inline(em,v.slice(3,-3),m,depth+1);n.append(em);}\n            else if(v.startsWith('||')){n=el('span','spoiler');n.tabIndex=0;n.setAttribute('role','button');n.setAttribute('aria-label','Reveal spoiler text');inside=v.slice(2,-2);n.onclick=()=>{n.classList.toggle('revealed');n.setAttribute('aria-pressed',String(n.classList.contains('revealed')));};n.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();n.click();}};}\n            else {const two=v.slice(0,2);const tag=two==='**'?'strong':two==='__'?'u':two==='~~'?'s':'em';const cut=tag==='em'?1:2;n=el(tag);inside=v.slice(cut,-cut);}\n            if(inside!==undefined)inline(n,inside,m,depth+1);parent.append(n);\n        }\n        lastIndex=re.lastIndex;\n    }\n    parent.append(document.createTextNode(text.slice(lastIndex)));\n}\nfunction highlight(code,lang){\n    const out=el('code');\n    if(!/^(js|javascript|jsx|ts|typescript|tsx|json|py|python|sh|bash|shell|bat|batch|ps1|powershell)$/i.test(lang)||code.length>100000){out.textContent=code;return out;}\n    const isPy=/^(py|python|sh|bash|shell|ps1|powershell)$/i.test(lang);\n    const re=isPy?/(#[^\\n]*|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|\\b(?:def|class|import|from|for|in|if|else|elif|return|try|except|finally|with|as|raise|async|await|True|False|None|print|echo|do|done)\\b|\\b\\d+(?:\\.\\d+)?\\b)/g:/(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|`(?:\\\\.|[^`\\\\])*`|\\b(?:const|let|var|function|class|return|if|else|for|while|new|true|false|null|undefined|async|await|try|catch|throw|import|from|export)\\b|\\b\\d+(?:\\.\\d+)?\\b)/g;\n    let end=0,hit;while((hit=re.exec(code))){out.append(document.createTextNode(code.slice(end,hit.index)));const s=hit[0];out.append(el('span',/^(#|\\/\\/|\\/\\*)/.test(s)?'tok-comment':/^[\"'`]/.test(s)?'tok-string':/^\\d/.test(s)?'tok-number':'tok-keyword',s));end=re.lastIndex;}out.append(document.createTextNode(code.slice(end)));return out;\n}\nfunction codeBlock(code,lang=''){\n    const box=el('div','code-block');const pre=el('pre');pre.append(highlight(code,lang));\n    const tools=el('div','code-controls');if(lang)tools.append(el('span','code-language',lang));tools.append(btn('Wrap Lines',()=>box.classList.toggle('wrap')),btn('Copy Code',()=>copyText(code)));box.append(tools,pre);return box;\n}\nfunction prose(parent,text,m,depth=0){\n    if(!text)return;\n    if(depth>8){const p=el('div','text');p.textContent=text;parent.append(p);return;}\n    const lines=text.split('\\n');let i=0;\n    while(i<lines.length){\n        const line=lines[i];let found;\n        if((found=/^(#{1,3}) +(.+)$/.exec(line))){const h=el('h'+found[1].length);inline(h,found[2],m);parent.append(h);i++;}\n        else if((found=/^-# +(.+)$/.exec(line))){const p=el('div','text subtext');inline(p,found[1],m);parent.append(p);i++;}\n        else if(/^>>> /.test(line)){const q=el('blockquote');prose(q,[line.slice(4),...lines.slice(i+1)].join('\\n'),m,depth+1);parent.append(q);break;}\n        else if(/^> ?/.test(line)){const buf=[];while(i<lines.length&&/^> ?/.test(lines[i]))buf.push(lines[i++].replace(/^> ?/,''));const q=el('blockquote');prose(q,buf.join('\\n'),m,depth+1);parent.append(q);}\n        else if((found=/^( *)([-*]|\\d+\\.) +(.+)$/.exec(line))){\n            const base=found[1].length,ordered=/\\d/.test(found[2]),list=el(ordered?'ol':'ul');if(ordered)list.start=Number.parseInt(found[2],10)||1;\n            while(i<lines.length){const a=/^( *)([-*]|\\d+\\.) +(.+)$/.exec(lines[i]);if(!a||a[1].length!==base||/\\d/.test(a[2])!==ordered)break;\n                const item=el('li');inline(item,a[3],m);i++;const nested=[];\n                while(i<lines.length&&/^ +\\S/.test(lines[i])&&lines[i].match(/^ */)[0].length>base)nested.push(lines[i++].slice(base+2));\n                if(nested.length)prose(item,nested.join('\\n'),m,depth+1);list.append(item);\n            }parent.append(list);\n        }else{\n            const buf=[line];i++;while(i<lines.length&&!/^(#{1,3} +|-# +|> ?| *([-*]|\\d+\\.) +)/.test(lines[i]))buf.push(lines[i++]);\n            const p=el('div','text');inline(p,buf.join('\\n'),m);parent.append(p);\n        }\n    }\n}\nfunction body(parent,value,m){\n    const text=String(value||'');let offset=0;\n    while(offset<text.length){const start=text.indexOf('```',offset);if(start<0){prose(parent,text.slice(offset),m);break;}\n        prose(parent,text.slice(offset,start),m);const close=text.indexOf('```',start+3);\n        if(close<0){prose(parent,text.slice(start),m);break;}\n        let inside=text.slice(start+3,close),lang='';const match=/^([\\w+-]*)\\r?\\n/.exec(inside);\n        if(match){lang=match[1];inside=inside.slice(match[0].length);}if(inside.endsWith('\\n'))inside=inside.slice(0,-1);\n        parent.append(codeBlock(inside,lang));offset=close+3;if(text[offset]==='\\n')offset++;\n    }\n}\nfunction imagePreview(path,name){$('media-name').textContent=name;$('media-image').src=path;$('media-image').alt=name;$('media-download').href=path;$('media-download').download=name;$('media-dialog').showModal();}\nfunction attachment(a){\n    const n=el('div','attachment');const name=String(a.filename||'attachment'),saved=a._archive?.status==='saved',path=saved?localFile(a._archive.path):null;\n    const fileInfo=()=>{const info=el('div','file-info');info.append(el('strong','',name),el('small','',bytes(a.size||0)));return info;};\n    const download=()=>{const l=el('a','','↓');l.href=path;l.download=name;l.title='Save Original File';l.setAttribute('aria-label','Download '+name);return l;};\n    if(!path){const info=el('div','file-box');info.append(el('span','file-icon','▤'),fileInfo());n.append(info,el('div','file-error','File not saved locally yet'+(a._archive?.error?' — '+a._archive.error:' — enable attachment downloads and back up again')));return n;}\n    if(/\\.(png|jpe?g|gif|webp|avif)$/i.test(name)){\n        n.classList.add('image-attachment');const b=btn('',()=>imagePreview(path,name),'image-button');b.setAttribute('aria-label','View image '+name);\n        const img=el('img');img.src=path;img.loading='lazy';img.alt=name;\n        const w=Number(a.width),h=Number(a.height);if(Number.isFinite(w)&&Number.isFinite(h)&&w>0&&h>0){const factor=Math.min(1,550/w,350/h);img.width=Math.max(1,Math.round(w*factor));img.height=Math.max(1,Math.round(h*factor));img.style.height='auto';img.style.aspectRatio=w+'/'+h;}\n        img.onerror=()=>{b.remove();n.append(el('div','file-error','Could not open local image: '+name+' — make sure the files folder was copied too'));};\n        b.append(img);const caption=el('div','image-caption',name+' · '+bytes(a.size||0)+' ');caption.append(download());n.append(b,caption);return n;\n    }\n    if(typeof a._archive.text==='string'){\n        n.classList.add('text-attachment','collapsed');const raw=a._archive.text,lines=raw.split('\\n').length,pre=el('pre');pre.append(el('code','',raw));const foot=el('div','attachment-footer');\n        const expand=btn('⌄',()=>{n.classList.toggle('collapsed');expand.textContent=n.classList.contains('collapsed')?'⌄':'⌃';expand.setAttribute('aria-expanded',String(!n.classList.contains('collapsed')));});expand.title='Expand / collapse '+lines+' lines';expand.setAttribute('aria-label','Expand / collapse file '+name);expand.setAttribute('aria-expanded','false');\n        foot.append(expand,fileInfo(),btn('Copy Full File',()=>copyText(raw)),download());n.append(pre,foot);return n;\n    }\n    const type=String(a.content_type||'');\n    if(type.startsWith('video/')||/\\.(mp4|webm|mov)$/i.test(name)){const v=el('video');v.src=path;v.controls=true;v.preload='none';n.append(v);}\n    else if(type.startsWith('audio/')||/\\.(mp3|m4a|wav|ogg|flac)$/i.test(name)){const audio=el('audio');audio.src=path;audio.controls=true;audio.preload='none';n.append(audio);}\n    const info=el('div','file-box');info.append(el('span','file-icon','▤'),fileInfo(),download());n.append(info);\n    if(/\\.(txt|md|py|js|json|csv|log|html?)$/i.test(name))n.append(el('div','muted','The original file is saved without an inline preview. Use Download to open it.'));\n    return n;\n}\nfunction canGroup(a,b){\n    if(!a||!b||!a.author?.id||!b.author?.id||a.type!==0||b.type!==0||a.message_reference||b.message_reference)return false;\n    const dt=new Date(b.timestamp)-new Date(a.timestamp);\n    return a.author.id===b.author.id&&a.webhook_id===b.webhook_id&&textName(a)===textName(b)&&dt>=0&&dt<=7*60000&&day(a.timestamp)===day(b.timestamp);\n}\nfunction rawMessage(m){showDialog('Raw message data',btn('Copy JSON',()=>copyText(JSON.stringify(m,null,2))),el('pre','',JSON.stringify(m,null,2)));}\nfunction menuFor(m,e){\n    e.preventDefault();e.stopPropagation();const menu=$('message-menu');menu.replaceChildren();\n    const action=(text,fn)=>menu.append(btn(text,()=>{menu.hidden=true;fn();}));\n    action('Copy Message',()=>copyText(m.content||''));action('Copy Message ID',()=>copyText(m.id));action('View Raw Data',()=>rawMessage(m));\n    menu.hidden=false;const rect=e.currentTarget.getBoundingClientRect();const x=e.clientX||rect.right,y=e.clientY||rect.bottom;\n    menu.style.left=Math.max(6,Math.min(x,innerWidth-menu.offsetWidth-6))+'px';menu.style.top=Math.max(6,Math.min(y,innerHeight-menu.offsetHeight-6))+'px';menu.querySelector('button').focus({preventScroll:true});\n}\nfunction renderMessage(m,c,previous){\n    const system=![0,19].includes(m.type??0);const n=el('article','message'+(system?' system':'')+(canGroup(previous,m)?' grouped':''));n.id='message-'+m.id;n.dataset.messageId=m.id;n.setAttribute('role','listitem');n.setAttribute('aria-label',textName(m)+' '+stamp(m.timestamp));\n    const actions=el('div','message-actions');actions.append(btn('Copy',()=>copyText(m.content||''),'copy'),btn('⋯',e=>menuFor(m,e),'more'));actions.lastChild.setAttribute('aria-label','More Actions');n.append(actions);n.addEventListener('contextmenu',e=>{if(e.target.closest('a,video,audio'))return;menuFor(m,e);});\n    if(m.message_reference?.message_id&&!system){const ref=m.message_reference,referenced=m.referenced_message;const r=btn('',()=>jumpMessage(ref.channel_id||c.id,ref.message_id),'reply');if(referenced?.author)r.append(el('strong','',textName(referenced)));r.append(document.createTextNode(String(referenced?.content||'Jump to the replied message').slice(0,180)));n.append(r);}\n    if(!system){\n        const hue=Array.from(String(m.author?.id||textName(m))).reduce((x,a)=>x+a.charCodeAt(0),0)%6;\n        n.append(el('div','avatar hue-'+hue,Array.from(textName(m)).slice(0,2).join('')));\n        const h=el('div','msg-header');const tm=el('time','timestamp',stamp(m.timestamp));tm.dateTime=m.timestamp;tm.title=stamp(m.timestamp,{dateStyle:'full',timeStyle:'long'});h.append(el('span','author',textName(m)),tm);n.append(h,el('time','compact-time',stamp(m.timestamp,{hour:'2-digit',minute:'2-digit',hour12:false})));\n    }else n.append(el('span','system-symbol',m.type===6?'⌖':'→'));\n    const content=el('div','message-body');\n    if(m.type===6){content.append(el('span','',textName(m)+' pinned messages in this channel'));if(m.message_reference?.message_id)content.append(btn('View Message',()=>jumpMessage(m.message_reference.channel_id||c.id,m.message_reference.message_id),'mention'));content.append(el('time','timestamp',' '+stamp(m.timestamp)));}\n    else body(content,m.content,m);\n    if(m.edited_timestamp)content.append(el('span','edited','(edited)'));\n    if(!m.content&&!m.attachments?.length&&!m.embeds?.length&&m.type!==6)content.append(el('span','muted',system?'System message type '+m.type+' — details are available in Raw Data':'This message has no text content'));\n    n.append(content);\n    for(const e of m.embeds||[]){const box=el('div','embed');if(e.title)box.append(e.url?link(e.url,e.title):el('strong','',e.title));if(e.description)body(box,e.description,m);for(const f of e.fields||[]){const field=el('div','embed-field');field.append(el('strong','',f.name));const v=el('div');body(v,f.value,m);field.append(v);box.append(field);}if(box.childNodes.length)n.append(box);}\n    for(const s of m.message_snapshots||[]){if(s.message?.content){const box=el('div','embed');box.append(el('div','muted','↪ Forwarded message'));body(box,s.message.content,m);n.append(box);}}\n    if(m.poll){const box=el('div','embed');box.append(el('strong','',m.poll.question?.text||'Poll'));for(const a of m.poll.answers||[])box.append(el('p','',a.poll_media?.text||''));n.append(box);}\n    for(const a of m.attachments||[])n.append(attachment(a));\n    if(m.reactions?.length){const r=el('div','reactions');for(const x of m.reactions)r.append(el('span','reaction',(x.emoji?.name||'reaction')+' '+number(x.count)));n.append(r);}\n    if(m.sticker_items?.length)n.append(el('div','muted','Stickers: '+m.sticker_items.map(x=>x.name||x.id).join(', ')));\n    return n;\n}\n// Serialized local reads: the callback validates data without executing it in Node.\nlet queue=Promise.resolve(),payload=null;\nwindow.DiscordArchiveData=d=>{payload=d;};\nfunction getPart(p){\n    if(partCache.has(p.file)){const x=partCache.get(p.file);partCache.delete(p.file);partCache.set(p.file,x);return Promise.resolve(x);}\n    const task=()=>new Promise((resolve,reject)=>{\n        if(!PART.test(p.file))return reject(new Error('Invalid message data filename'));\n        payload=null;const script=el('script');let ended=false;\n        const done=(error,data)=>{if(ended)return;ended=true;clearTimeout(timer);script.remove();if(error)reject(error);else{partCache.set(p.file,data);while(partCache.size>8)partCache.delete(partCache.keys().next().value);resolve(data);}};\n        const timer=setTimeout(()=>done(new Error('Timed out while opening the message data file after 10 seconds')),10000);\n        script.src=p.file;script.onload=()=>{\n            const d=payload;payload=null;\n            if(!d||d.schema!==1||!Array.isArray(d.messages)||d.channelId!==p.file.split('/')[1]||d.messages.length!==p.count)return done(new Error('The message data file does not match the catalog'));\n            let previous=null;for(const m of d.messages){if(typeof m.id!=='string'||!ID.test(m.id)||String(m.channel_id)!==d.channelId||(previous!==null&&cmp(previous,m.id)>=0))return done(new Error('Message IDs are invalid, duplicated, from the wrong channel, or out of order'));previous=m.id;}\n            if(d.messages.length&&(d.messages[0].id!==p.lo||d.messages[d.messages.length-1].id!==p.hi))return done(new Error('The message range does not match the catalog'));done(null,d.messages);\n        };script.onerror=()=>done(new Error('Message data file is missing or could not be opened: '+p.file));document.head.append(script);\n    });const promise=queue.then(task,task);queue=promise.catch(()=>{});return promise;\n}\nfunction chunk(index,messages,c){\n    const node=el('section','history-part');node.dataset.part=String(index);let previous=null;\n    for(const m of messages){if(!previous||day(previous.timestamp)!==day(m.timestamp)){const divider=el('div','day-divider',day(m.timestamp));if(!previous)divider.dataset.seam='true';node.append(divider);}node.append(renderMessage(m,c,previous));previous=m;}\n    return {index,messages,node};\n}\nfunction seams(){let prev=null;for(let i=first;i<=last;i++){const b=blocks.get(i);if(!b)continue;const m=b.messages[0],divider=b.node.querySelector('[data-seam]'),message=b.node.querySelector('.message');if(divider)divider.classList.toggle('seam-hidden',!!prev&&day(prev.timestamp)===day(m.timestamp));if(message)message.classList.toggle('grouped',canGroup(prev,m));prev=b.messages[b.messages.length-1];}}\nfunction anchor(){const top=scroll.getBoundingClientRect().top;for(const n of feed.querySelectorAll('.message')){const r=n.getBoundingClientRect();if(r.bottom>top+2)return {mid:n.dataset.messageId,offset:r.top-top,part:Number(n.closest('.history-part').dataset.part)};}return null;}\nfunction restoreAnchor(a){if(!a)return;const n=$('message-'+a.mid);if(n)scroll.scrollTop+=n.getBoundingClientRect().top-scroll.getBoundingClientRect().top-a.offset;}\nfunction remember(){if(active){const a=anchor();if(a)positions.set(active.id,a);}}\nfunction updateHeader(){\n    if(!active)return;$('channel-title').textContent=active.name;$('channel-topic').textContent=active.topic||'';$('channel-topic').hidden=!active.topic;\n    const incomplete=active.inProgress||!active.historyComplete||!!active.error;\n    $('channel-meta').textContent=number(active.count)+' messages · '+number(active.savedFiles)+'/'+number(active.files)+' files · read-only';\n    $('coverage').className='coverage'+(incomplete||active.pending||loadError?' incomplete':'');\n    $('coverage').textContent=loadError?'Could not read data':incomplete?'History incomplete':active.pending?'Missing '+number(active.pending)+' files':'Complete up to the last backup run';\n    $('coverage').title=active.error||('Latest history check: '+stamp(active.checkedAt));\n    document.title='#'+active.name+' — '+catalog.guild.name+' · Offline Archive';\n}\nfunction describeArchive(){\n    if(!active){showDialog('Archive Details',el('p','',catalog.guild.name),el('p','', 'Saved '+stamp(catalog.updatedAt)));return;}\n    showDialog('#'+active.name,el('p','',number(active.count)+' messages · '+number(active.savedFiles)+'/'+number(active.files)+' local files'),el('p','',active.from?stamp(active.from)+' – '+stamp(active.to):'No saved messages yet'),el('p','', 'Currently viewing range '+(last>=first?number(first+1)+'–'+number(last+1):'0')+' of '+number(active.parts.length)+' data batches'),el('p','',active.error||loadError?.message||'Data from backup run '+stamp(active.checkedAt)),el('p','', 'Profile pictures that were not saved are shown as initials. No profile images are fetched from Discord while reading.'));\n}\nfunction edges(){\n    const older=$('older-status'),newer=$('newer-status');older.replaceChildren();newer.replaceChildren();older.className=newer.className='history-edge';\n    if(!active||!active.parts.length)return;\n    if(first>0)older.append(btn(loading?'Opening older messages…':'↑ Scroll Up to Read Earlier Messages',()=>loadAdjacent(-1,true)));\n    else older.append(el('span','',active.historyComplete?'You have reached the oldest messages in the archive':'Beginning of saved data — history is incomplete'));\n    if(last<active.parts.length-1)newer.append(btn(loading?'Opening messages…':'Read Next Messages ↓',()=>loadAdjacent(1,true)));\n    if(loadError){const target=loadError.direction===1?newer:older;target.classList.add('error');target.replaceChildren(el('span','',loadError.message+' '),btn('Try Reading Again',()=>loadError.direction===0?showAt(active,first):loadAdjacent(loadError.direction,true)));}\n    $('jump-latest').hidden=last>=active.parts.length-1&&scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<160;\n    feed.dataset.first=String(first);feed.dataset.last=String(last);updateHeader();\n}\nfunction trim(direction){\n    while(blocks.size>MAX_PARTS){const index=direction<0?last:first;const b=blocks.get(index);if(b){b.node.remove();blocks.delete(index);}if(direction<0)last--;else first++;}\n}\nasync function loadAdjacent(direction,manual=false){\n    if(!active||loading||!active.parts.length||(!manual&&loadError))return;\n    const index=direction<0?first-1:last+1;if(index<0||index>=active.parts.length)return;\n    const gen=generation,c=active;loading=true;loadError=null;edges();\n    try{const data=await getPart(c.parts[index]);if(gen!==generation)return;const a=anchor(),oldTop=scroll.scrollTop,oldHeight=scroll.scrollHeight;\n        const b=chunk(index,data,c);blocks.set(index,b);if(direction<0){feed.prepend(b.node);first=index;}else{feed.append(b.node);last=index;}\n        trim(direction);seams();edges();if(a)restoreAnchor(a);else if(direction<0)scroll.scrollTop=oldTop+scroll.scrollHeight-oldHeight;\n    }catch(e){if(gen===generation)loadError={message:e.message,direction};}\n    finally{if(gen===generation){loading=false;edges();}}\n}\nasync function showAt(c,index,{mid=null,offset=null,latest=false}={}){\n    const gen=++generation;loading=true;loadError=null;blocks.clear();first=index;last=index;feed.replaceChildren(el('div','empty','Opening local archive…'));$('older-status').replaceChildren();$('newer-status').replaceChildren();$('jump-latest').hidden=true;updateHeader();\n    if(!c.parts.length){loading=false;first=0;last=-1;feed.replaceChildren(el('div','empty',c.historyComplete?'This channel has no saved messages':'No message batch has been saved successfully yet'));edges();return;}\n    try{const data=await getPart(c.parts[index]);if(gen!==generation)return;const b=chunk(index,data,c);blocks.set(index,b);feed.replaceChildren(b.node);seams();edges();\n        const target=mid?$('message-'+mid):null;\n        if(target){if(offset===null)target.classList.add('target');const top=target.getBoundingClientRect().top-scroll.getBoundingClientRect().top;scroll.scrollTop+=top-(offset??Math.max(25,scroll.clientHeight/3));}\n        else if(latest)scroll.scrollTop=scroll.scrollHeight;else scroll.scrollTop=0;\n        if(mid&&!target)toast('This message was not found in the saved archive');\n    }catch(e){if(gen===generation){loadError={message:e.message,direction:0};feed.replaceChildren(el('div','empty',e.message),btn('Try Again',()=>showAt(c,index,{mid,offset,latest})));}}\n    finally{if(gen===generation){loading=false;edges();if(!loadError&&!mid)void fillViewport(gen,latest?-1:1);}}\n}\nasync function fillViewport(gen,direction){\n    // A final part may contain only one message: fill enough to enable scrolling.\n    while(gen===generation&&!loading&&!loadError&&active&&scroll.scrollHeight<=scroll.clientHeight+80){\n        if(direction<0?first<=0:last>=active.parts.length-1)break;\n        await loadAdjacent(direction);\n    }\n}\nasync function selectChannel(cid,opts={}){\n    const c=catalog.channels.find(x=>String(x.id)===String(cid));if(!c)return toast('This channel is not in the saved archive');\n    remember();active=c;$('message-menu').hidden=true;$('jump-popover').hidden=true;document.body.classList.remove('sidebar-open');\n    const saved=opts.index===undefined&&!opts.mid?positions.get(c.id):null;\n    const index=opts.index??saved?.part??Math.max(0,c.parts.length-1);\n    renderChannels();await showAt(c,Math.max(0,Math.min(index,c.parts.length-1)),{mid:opts.mid??saved?.mid,offset:saved?.offset??null,latest:!saved&&opts.index===undefined&&!opts.mid});\n}\nasync function jumpMessage(cid,mid){\n    const c=catalog.channels.find(x=>String(x.id)===String(cid));if(!c||!ID.test(String(mid)))return toast('The source message is not in the saved archive');\n    const index=c.parts.findIndex(p=>cmp(p.lo,mid)<=0&&cmp(p.hi,mid)>=0);if(index<0)return toast('The source message is not in the saved archive');\n    if(innerWidth<=820)$('search-panel').hidden=true;await selectChannel(cid,{index,mid});\n}\nfunction goLatest(){if(active)void showAt(active,Math.max(0,active.parts.length-1),{latest:true});$('jump-popover').hidden=true;}\nfunction onScroll(){\n    if(scrollFrame)return;scrollFrame=requestAnimationFrame(()=>{scrollFrame=0;if(!active||loading)return;\n        $('jump-latest').hidden=last>=active.parts.length-1&&scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<160;\n        if(scroll.scrollTop<140&&first>0)void loadAdjacent(-1);\n        else if(scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<140&&last<active.parts.length-1)void loadAdjacent(1);\n    });\n}\n// The archive may contain only a subset of rooms. Never invent missing rooms.\nfunction renderChannels(){\n    const q=$('channel-filter').value.trim().toLocaleLowerCase('th'),list=$('channel-list');list.replaceChildren();\n    const layout=Array.isArray(catalog.channelLayout?.channels)?catalog.channelLayout.channels:[];\n    const meta=new Map(layout.map(c=>[String(c.id),c]));\n    const rooms=new Map(catalog.channels.map(c=>[String(c.id),c]));const groups=new Map();\n    for(const c of catalog.channels){\n        const isThread=[10,11,12].includes(c.type);const parent=isThread?(meta.get(String(c.parentId))||rooms.get(String(c.parentId))):null;\n        const entry=meta.get(String(c.id))||c;\n        const catId=isThread?(parent?.parentId||null):(entry.parentId||c.parentId||null);\n        const category=meta.get(String(catId));const title=category?.type===4?category.name:(isThread?(c.category||'').split(' / ')[0]:c.category)||'Channels';\n        const gkey=category?.type===4?String(category.id):title;\n        if(!groups.has(gkey))groups.set(gkey,{id:gkey,title,position:category?.position??(catId?100000:-1),rooms:[]});\n        groups.get(gkey).rooms.push({c,isThread,parent,position:(isThread?parent?.position:entry.position)??100000});\n    }\n    for(const g of [...groups.values()].sort((a,b)=>a.position-b.position)){\n        if(layout.length)g.rooms.sort((a,b)=>a.position-b.position||String(a.isThread?a.c.parentId:a.c.id).localeCompare(String(b.isThread?b.c.parentId:b.c.id))||Number(a.isThread)-Number(b.isThread)||cmp(a.c.id,b.c.id));\n        const matches=g.rooms.filter(x=>!q||x.c.name.toLocaleLowerCase('th').includes(q)||g.title.toLocaleLowerCase('th').includes(q)||(x.parent?.name||'').toLocaleLowerCase('th').includes(q));if(!matches.length)continue;\n        const group=el('div','channel-category'),header=btn('',()=>{if(collapsed.has(g.id))collapsed.delete(g.id);else collapsed.add(g.id);try{localStorage.setItem(key+':collapsed',JSON.stringify([...collapsed]));}catch(_){}renderChannels();},'category');\n        const isClosed=collapsed.has(g.id)&&!q;header.setAttribute('aria-expanded',String(!isClosed));header.append(el('span','category-chevron',isClosed?'›':'⌄'),el('span','',g.title));group.append(header);let parentShown=null;\n        for(const {c,isThread,parent} of matches){if(isClosed&&active?.id!==c.id)continue;\n            if(isThread&&parent&&!rooms.has(String(c.parentId))&&parentShown!==c.parentId){group.append(el('div','thread-parent','# '+parent.name));parentShown=c.parentId;}\n            const n=btn('',()=>selectChannel(c.id),'channel'+(active?.id===c.id?' active':'')+(isThread?' thread':''));n.dataset.channelId=c.id;n.setAttribute('aria-current',active?.id===c.id?'page':'false');\n            const incomplete=c.inProgress||!c.historyComplete||c.pending||c.error;\n            n.append(el('span','channel-symbol',isThread?'↳':[2,13].includes(c.type)?'♪':'#'),el('span','channel-name',c.name),el('span','channel-count'+(incomplete?' incomplete':''),incomplete?'•':number(c.count)));n.title=c.name+' · '+number(c.count)+' messages'+(incomplete?' · some data is still incomplete':'');group.append(n);\n        }list.append(group);\n    }\n    if(!list.childNodes.length)list.append(el('div','empty','No channels match your search'));\n}\nfunction searchText(m){return [m.content,textName(m),m.author?.username,...(m.embeds||[]).flatMap(e=>[e.title,e.description,...(e.fields||[]).flatMap(f=>[f.name,f.value])]),...(m.attachments||[]).flatMap(a=>[a.filename,a._archive?.text]),...(m.message_snapshots||[]).map(x=>x.message?.content)].filter(x=>typeof x==='string').join('\\n');}\nconst normalized=s=>String(s).normalize('NFC').toLocaleLowerCase('th');\nasync function search(){\n    const q=$('query').value.trim();if(!q){toast('Enter a search term first.');$('query').focus();return;}$('search-panel').hidden=false;\n    const targets=$('search-scope').value==='all'?catalog.channels:active?[active]:[];if(!targets.length)return toast('Choose a channel before searching');\n    const gen=++searchGeneration;searching=true;resultPage=0;results=[];totalHits=0;$('search-stop').hidden=false;$('search-results').replaceChildren();$('result-nav').replaceChildren();\n    const all=targets.flatMap(c=>c.parts.map(p=>({c,p}))),total=all.reduce((a,{p})=>a+p.count,0);let scanned=0,errors=0;const needle=normalized(q);\n    for(const {c,p} of all){if(gen!==searchGeneration)break;\n        try{const messages=await getPart(p);if(gen!==searchGeneration)break;for(const m of messages){const raw=searchText(m),pos=normalized(raw).indexOf(needle);if(pos>=0){totalHits++;if(results.length<2000)results.push({cid:c.id,mid:m.id,name:c.name,time:m.timestamp,author:textName(m),snippet:raw.slice(Math.max(0,pos-70),pos+220)});}}scanned+=messages.length;}catch(_){errors++;}\n        $('search-status').textContent='Scanned '+number(scanned)+' / '+number(total)+' messages · Found '+number(totalHits);await new Promise(r=>setTimeout(r,0));\n    }\n    if(gen!==searchGeneration)return;searching=false;$('search-stop').hidden=true;\n    $('search-status').textContent='Search complete: found '+number(totalHits)+'  matches from '+number(scanned)+' messages'+(totalHits>2000?' · Showing the first 2,000 matches — refine your query for more precise results.':'')+(errors?' · Could not read '+errors+' batches, so the search is not fully complete.':'')+'\\nText-file search covers files with full text embedded in the archive.';renderResults();\n}\nfunction renderResults(){\n    const container=$('search-results'),nav=$('result-nav');container.replaceChildren();nav.replaceChildren();const size=40,start=resultPage*size;\n    for(const r of results.slice(start,start+size)){const box=el('article','search-hit');box.append(el('strong','', '#'+r.name+' · '+r.author),el('div','muted',stamp(r.time)),el('p','',r.snippet),btn('Go to Message',()=>jumpMessage(r.cid,r.mid)));container.append(box);}\n    if(!results.length)container.append(el('div','empty','No messages matching your query were found in the readable archive data'));\n    if(resultPage>0)nav.append(btn('←',()=>{resultPage--;renderResults();container.scrollTop=0;}));if(results.length)nav.append(el('span','',number(resultPage+1)+' / '+number(Math.ceil(results.length/size))));if(start+size<results.length)nav.append(btn('→',()=>{resultPage++;renderResults();container.scrollTop=0;}));\n}\nfunction closeSearch(){searchGeneration++;searching=false;$('search-stop').hidden=true;$('search-panel').hidden=true;}\nfunction init(){\n    if(!catalog||catalog.schema!==1||!Array.isArray(catalog.channels)){feed.replaceChildren(el('div','empty','catalog.js was not found or the archive format is unsupported. Open index.html from the extracted backup folder.'));$('guild-name').textContent='Could not open archive';return;}\n    try{if(localStorage.getItem('discordArchiveTheme')==='light')document.body.classList.add('light');const value=JSON.parse(localStorage.getItem(key+':collapsed')||'[]');if(Array.isArray(value))value.forEach(x=>collapsed.add(String(x)));}catch(_){}\n    $('reader-version').textContent='v'+READER_VERSION;$('guild-name').textContent=catalog.guild.name;$('server-icon').textContent=Array.from(catalog.guild.name).filter(s=>s.trim()).slice(0,2).join('')||'DA';$('server-icon').title=catalog.guild.name+' — Show / Hide Channels';$('archive-date').textContent=stamp(catalog.updatedAt);\n    const warnings=[...(catalog.warnings||[])];if(catalog.demo)warnings.unshift('Demo data for preview purposes — not history from your account');if(['running','paused'].includes(catalog.lastRun?.status))warnings.push('The latest backup run has not finished yet. Saved messages are readable, but the history may still be incomplete.');\n    if(warnings.length){$('global-warning').textContent=warnings.join('\\n');$('global-warning').hidden=false;}\n    $('channel-filter').addEventListener('input',renderChannels);scroll.addEventListener('scroll',onScroll,{passive:true});\n    $('server-icon').onclick=()=>document.body.classList.toggle('sidebar-hidden');$('toggle-channels').onclick=()=>document.body.classList.toggle('sidebar-open');\n    $('theme').onclick=()=>{document.body.classList.toggle('light');try{localStorage.setItem('discordArchiveTheme',document.body.classList.contains('light')?'light':'dark');}catch(_){};};\n    $('help-button').onclick=()=>$('help').showModal();$('help-close').onclick=()=>$('help').close();$('archive-info').onclick=describeArchive;$('coverage').onclick=describeArchive;$('detail-close').onclick=()=>$('detail-dialog').close();$('media-close').onclick=()=>{$('media-dialog').close();$('media-image').removeAttribute('src');};\n    $('jump-toggle').onclick=()=>$('jump-popover').hidden=!$('jump-popover').hidden;$('first').onclick=()=>{if(active)void showAt(active,0);$('jump-popover').hidden=true;};$('last').onclick=goLatest;$('jump-latest').onclick=goLatest;\n    $('jump-date').onchange=()=>{if(!active||!$('jump-date').value)return;if(!active.parts.length)return toast('This channel has no saved messages yet');const time=new Date($('jump-date').value+'T00:00:00').getTime();const i=active.parts.findIndex(p=>new Date(p.to).getTime()>=time);const index=i<0?Math.max(0,active.parts.length-1):i;\n        void (async()=>{const c=active,gen=generation;try{const messages=await getPart(c.parts[index]);if(c!==active||gen!==generation)return;const target=messages.find(m=>new Date(m.timestamp).getTime()>=time)||messages[messages.length-1];await showAt(c,index,{mid:target?.id});}catch(e){toast(e.message);}})();$('jump-popover').hidden=true;\n    };\n    $('search-form').onsubmit=e=>{e.preventDefault();void search();};$('search-scope').onchange=()=>{if($('query').value.trim())void search();};$('search-clear').onclick=closeSearch;$('search-stop').onclick=()=>{searchGeneration++;searching=false;$('search-stop').hidden=true;$('search-status').textContent+=' · Paused — search results are incomplete';renderResults();};\n    $('query').onfocus=()=>{$('search-panel').hidden=false;};document.addEventListener('click',e=>{if(!e.target.closest('#message-menu,.more'))$('message-menu').hidden=true;if(!e.target.closest('#jump-popover,#jump-toggle'))$('jump-popover').hidden=true;});\n    document.addEventListener('keydown',e=>{if(e.key==='Escape'){$('message-menu').hidden=true;$('jump-popover').hidden=true;document.body.classList.remove('sidebar-open');if(!document.querySelector('dialog[open]'))closeSearch();}});\n    renderChannels();if(catalog.channels.length)void selectChannel(catalog.channels[0].id);else feed.replaceChildren(el('div','empty','No channels have been saved successfully in this archive yet'));\n}\ninit();\n})();\n"};

},
"./styles":function(module,exports,require){
'use strict';
module.exports=".da-backdrop{position:fixed;inset:0;z-index:1000000;display:flex;align-items:center;justify-content:center;padding:20px;background:#060910bd;font:14px/1.5 \"Segoe UI\",Arial,sans-serif;color:#e8eaf1}\n.da-panel{box-sizing:border-box;width:860px;max-width:100%;max-height:94vh;overflow:auto;overscroll-behavior:contain;scrollbar-color:#4a5269 #181c28;scrollbar-width:thin;color-scheme:dark;background:#1e2332;border:1px solid #414960;border-radius:16px;box-shadow:0 24px 90px #0009;padding:24px}\n.da-panel *{box-sizing:border-box}.da-panel [hidden]{display:none!important}.da-panel h2{font:700 22px/1.3 \"Segoe UI\",Arial,sans-serif;color:#f7f8ff;margin:0;letter-spacing:-.3px}.da-panel p{margin:4px 0 12px}.da-head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:18px}.da-brand{display:flex;gap:12px;align-items:center;min-width:0}.da-brand-mark{height:42px;width:42px;display:grid;place-items:center;flex-shrink:0;border-radius:12px;border:1px solid #6d79ff55;background:#5965ef22;color:#b8beff}.da-icon{width:21px;height:21px}.da-muted{font-size:12px;color:#b0b9cc}.da-version{display:inline-block;border:1px solid #4a536b;border-radius:5px;padding:1px 6px;margin-left:7px;font-size:11px;color:#c4cbe0}.da-panel button,.da-settings button{appearance:none;font:600 12px/1.5 \"Segoe UI\",Arial,sans-serif;background:#30394f;border:1px solid #515d78;color:#f1f4fd;padding:9px 13px;border-radius:8px;cursor:pointer;transition:background .12s,border-color .12s;white-space:nowrap;min-height:36px}.da-panel button:hover:not(:disabled){background:#3a4560;border-color:#7988ac}.da-panel button:disabled{opacity:.45;cursor:not-allowed}.da-panel button.da-primary{background:#5865f2;border-color:#7681ff;color:#fff}.da-panel button.da-primary:hover:not(:disabled){background:#6874fc}.da-panel button.da-quiet{background:transparent;color:#c2cadd;border-color:#414c65}.da-panel :is(button,input,select):focus-visible{outline:2px solid #a8b0ff;outline-offset:2px}.da-panel :is(input[type=text],input[type=search],select){appearance:auto;font:13px/1.5 \"Segoe UI\",Arial,sans-serif;background:#151a26;color:#e8ecf5;border:1px solid #46516b;border-radius:8px;padding:9px 11px;min-height:39px;min-width:0;width:100%}.da-panel select:disabled{opacity:.55}.da-panel select option{background:#202638;color:#edf1fa}.da-field-label{display:flex;justify-content:space-between;align-items:center;color:#e1e6f5;font-size:12px;font-weight:600;margin:0 0 6px}.da-server-section{border:1px solid #3e4861;background:#242b3d;padding:14px;border-radius:11px;margin-bottom:14px}.da-server-row{display:flex;gap:10px;align-items:center}.da-server-avatar{width:39px;height:39px;display:grid;place-items:center;border-radius:10px;background:#343e59;color:#d4d9ff;font-weight:700;flex-shrink:0}.da-server-row select{flex:1}.da-server-meta{font-size:11px;color:#aeb9ce;margin:8px 0 0 49px;overflow-wrap:anywhere;min-height:17px}.da-path-row{display:flex;gap:8px}.da-path-row input{flex:1}.da-local-note{margin:6px 0 15px;font-size:11px;color:#abb6ce;overflow-wrap:anywhere}.da-local-note.da-warning{color:#edc684}.da-row{display:flex;gap:8px;align-items:center;margin:12px 0 8px;flex-wrap:wrap}.da-row>input{flex:1;min-width:180px!important}.da-channel-heading{display:flex;justify-content:space-between;gap:10px;font-size:11px;color:#a8b5cf;margin-bottom:7px}.da-channel-list{height:230px;min-height:100px;overflow:auto;overscroll-behavior:contain;scrollbar-color:#505c78 #171c29;scrollbar-width:thin;border:1px solid #3e4860;border-radius:9px;background:#171c29;padding:7px}.da-channel-list::-webkit-scrollbar,.da-panel::-webkit-scrollbar{width:8px}.da-channel-list::-webkit-scrollbar-thumb,.da-panel::-webkit-scrollbar-thumb{background:#48556f;border-radius:8px}.da-channel-list::-webkit-scrollbar-track,.da-panel::-webkit-scrollbar-track{background:#171c29}.da-channel{display:flex;gap:9px;align-items:center;padding:8px 9px;border-radius:6px;cursor:pointer}.da-channel:hover{background:#293249}.da-channel:has(input:checked){background:#5766ed17}.da-panel input[type=checkbox]{appearance:auto;-webkit-appearance:checkbox;accent-color:#818cff;width:15px;height:15px;margin:0;flex-shrink:0;position:static;opacity:1}.da-channel-name{flex:1;min-width:0;overflow-wrap:anywhere;font-size:13px}.da-channel-state{font-size:11px;color:#a8b4cd;text-align:right;max-width:42%}.da-category{font-size:10px;letter-spacing:.6px;text-transform:uppercase;font-weight:700;color:#a3b0ce;margin:10px 9px 4px}.da-empty{padding:22px 14px;color:#aebbd3;text-align:center;font-size:13px}.da-choices{display:flex;gap:14px;flex-wrap:wrap;margin:14px 0}.da-choices label{display:flex;align-items:center;gap:8px;font-size:12px;color:#d0d7e7}.da-status{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #44506a;border-radius:9px;padding:12px 14px;margin-top:12px;background:#181e2c;min-height:61px;font-size:12px;color:#dfe5f5}.da-status.da-error{border-color:#95703f;color:#f4d5a2}.da-status.da-running{border-color:#6574e1}.da-feedback{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:8px;padding:8px 11px;border-radius:7px;background:#6070a01a;color:#c4d0eb;font-size:12px;border-left:3px solid #8898cd}.da-feedback[data-type=warning],.da-feedback[data-type=error]{background:#d8a34b12;color:#f2d099;border-color:#d8a34b}.da-feedback[data-type=success]{color:#addec3;border-color:#67be91}.da-footer{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.da-action-hint{font-size:11px;color:#b6bfd4;margin:8px 0 0;min-height:16px}.da-details{font-size:12px;color:#aebbd5;margin-top:14px;border-top:1px solid #394258;padding-top:12px}.da-details summary{cursor:pointer;min-height:24px}.da-details pre{white-space:pre-wrap;max-height:160px;overflow:auto;font:11px/1.6 Consolas,monospace;background:#151a26;padding:10px;border-radius:6px;color:#c1cee8}.da-detail-actions{display:flex;gap:8px;flex-wrap:wrap}.da-info{font-size:10px;line-height:1.6;color:#9da9c0;margin-top:12px}.da-settings{color:var(--text-normal);padding:16px;display:grid;gap:12px}.da-settings h2{margin:0}.da-settings p{line-height:1.6;margin:0}\n@media(max-width:660px){.da-backdrop{padding:8px}.da-panel{padding:15px;max-height:96vh}.da-panel h2{font-size:18px}.da-brand-mark{display:none}.da-row{gap:6px}.da-row>input{flex-basis:100%}.da-server-meta{margin-left:0}.da-channel-list{height:205px}.da-channel-state{max-width:40%;font-size:10px}.da-footer button{flex-grow:1}.da-path-row{flex-wrap:wrap}.da-path-row input{flex-basis:65%}.da-panel button{padding:8px 10px}.da-choices{gap:9px}}\n@media(prefers-reduced-motion:reduce){.da-panel *{transition:none!important}}\n";

},
"./plugin":function(module,exports,require){
'use strict';
const {path,fsp,defaultFolder,runtimeSummary}=require('./runtime');
const {DiskArchive,HistoryEngine,id,atomicWrite,readJSON,isDiskError,now}=require('./core');
const {DiscordClient,CONTAINERS,ownerState}=require('./discord');
const {NAME,VERSION,STORAGE_KEY}=require('./meta');
const assets=require('./assets');
const CSS=require('./styles');
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;};
const btn=(text,fn,cls='')=>{const b=el('button',cls,text);b.type='button';b.onclick=fn;return b;};
const fmt=n=>Number(n||0).toLocaleString('en-US');
const prettyDate=t=>{try{return new Date(t).toLocaleString('en-US',{dateStyle:'medium',timeStyle:'short'});}catch(_){return 'Unknown date';}};
function archiveError(message,code='DA_ARCHIVE_NOT_READY'){return Object.assign(new Error(message),{code});}
function initials(name){return Array.from(String(name||'?')).slice(0,2).join('').toUpperCase();}

module.exports=class BackupDataDiscordServer {
    start(){
        this.bd=BdApi;this.enabled=true;this.unpatch=[];this.controller=null;this.jobPromise=null;this.panel=null;this.lastError=null;
        // Keep the old storage key: renaming the plugin must not reset paths or selections.
        const saved=this.bd.Data.load(STORAGE_KEY,'settings');
        this.settings={folder:defaultFolder(),files:true,threads:true,selected:{},lastServerId:null,...(saved&&typeof saved==='object'?saved:{})};
        if(!this.settings.selected||typeof this.settings.selected!=='object')this.settings.selected={};
        this.bd.DOM.addStyle(STORAGE_KEY,CSS);
        this.unpatch.push(this.bd.ContextMenu.patch('guild-context',(tree,props)=>{
            try{
                const gid=props?.guild?.id??props?.guildId;
                if(!gid||!this.isOwner(gid)||!tree?.props)return;
                const groups=this.bd.ContextMenu.buildMenuChildren([{type:'group',items:[{id:'discord-archive-backup',label:'Back Up Server Data…',action:()=>this.open(String(gid))}]}]);
                if(Array.isArray(tree.props.children))tree.props.children.push(...groups);else tree.props.children=[tree.props.children,...groups];
            }catch(e){this.lastError='Could not add the server menu: '+e.message;}
        }));
    }
    stop(){
        this.enabled=false;this.controller?.abort();this.panel?.dispose();this.panel=null;
        this.unpatch?.forEach(fn=>{try{fn();}catch(_){}});this.unpatch=[];this.bd.DOM.removeStyle(STORAGE_KEY);
        // Do not force-unlock an in-flight disk operation. The job finalizer releases it.
    }
    live(p){return !!p&&this.enabled&&this.panel===p&&!p.disposed;}
    saveSettings(){this.bd.Data.save(STORAGE_KEY,'settings',this.settings);}
    isOwner(gid){const W=this.bd.Webpack;return ownerState(W.getStore('GuildStore'),W.getStore('UserStore'),gid).status==='owner';}
    owned(){const gs=this.bd.Webpack.getStore('GuildStore');return Object.values(gs?.getGuilds?.()||{}).filter(g=>g&&this.isOwner(g.id)).sort((a,b)=>String(a.name).localeCompare(String(b.name),'en')) ;}
    alert(message){this.bd.UI.alert(NAME,String(message));}
    notify(p,text,type='info'){
        if(!this.live(p))return;
        p.feedback.hidden=false;p.feedback.textContent=String(text);p.feedback.dataset.type=type;
    }
    root(gid,folder=this.settings.folder){
        if(!gid)throw archiveError('Choose a server first.','DA_SERVER_REQUIRED');
        if(typeof folder!=='string'||!folder.trim()||!path.isAbsolute(folder.trim()))throw archiveError('Choose an absolute archive folder path first.','DA_FOLDER_REQUIRED');
        return path.join(path.resolve(folder.trim()),id(gid));
    }
    persist(p){
        if(!this.live(p))return false;
        if(p.gid&&p.ready)this.settings.selected[p.gid]=[...p.rows.values()].filter(r=>r.checkbox.checked).map(r=>String(r.channel.id));
        this.settings.lastServerId=p.gid||null;this.settings.files=p.files.checked;this.settings.threads=p.threads.checked;
        const folder=p.folder.value.trim();if(folder&&path.isAbsolute(folder))this.settings.folder=folder;
        try{this.saveSettings();return true;}catch(e){p.lastErrorCode='DA_SETTINGS_SAVE';this.notify(p,'Could not save settings: '+e.message,'error');return false;}
    }
    getSettingsPanel(){
        const box=el('div','da-settings');box.append(el('h2','',NAME),el('p','',`Version ${VERSION}`),el('p','', 'Choose a server and its channels in the backup manager. Server switching, local archives, and backup status are all available there.'));
        box.append(btn('Open Backup Manager',()=>this.open()));
        if(this.lastError)box.append(el('p','',this.lastError));
        box.append(el('p','', 'Nothing is backed up until you click Back Up / Resume. Existing messages and resume points are kept.'));
        return box;
    }
    open(gid){
        if(!this.enabled)return;
        const current=this.panel;
        if(current&&!current.disposed){
            current.overlay.style.display='flex';
            if(gid===undefined||String(gid||'')===String(current.gid||'')){current.server.focus();return current;}
            return this.switchServer(current,String(gid||''));
        }
        if(gid===undefined){const last=this.settings.lastServerId;gid=last&&this.isOwner(last)?String(last):'';}
        gid=gid?String(gid):'';
        if(gid&&!this.isOwner(gid)){this.alert('This server is not available as an owned server. Choose one from the backup manager.');gid='';}
        return this.createPanel(gid);
    }
    switchServer(p,gid){
        if(!this.live(p))return;
        if(p.busy||p.localBusy||this.jobPromise){p.server.value=p.gid||'';this.notify(p,'Wait for the current action to finish. To change servers during a backup, click Pause and wait until the resume point is saved.','warning');return p;}
        if(gid&&!this.isOwner(gid)){p.server.value=p.gid||'';this.notify(p,'That server is no longer available as an owned server. Open the Server selector to refresh its list, then choose again.','warning');return p;}
        if(!this.persist(p)){p.server.value=p.gid||'';return p;}
        this.settings.lastServerId=gid||null;
        try{this.saveSettings();}catch(e){p.server.value=p.gid||'';this.notify(p,'Could not save the selected server: '+e.message,'error');return p;}
        p.dispose();this.panel=null;
        return this.createPanel(gid);
    }
    createPanel(gid){
        const guild=gid?this.bd.Webpack.getStore('GuildStore')?.getGuild(gid):null;
        const p={gid:gid||null,guild,client:null,channels:[],rows:new Map(),overlay:el('div','da-backdrop'),loadController:new AbortController(),ready:false,loading:false,busy:false,localBusy:false,operation:null,disposed:false,archive:null,archiveGeneration:0,lastErrorCode:null,previousFocus:document.activeElement};
        this.panel=p;
        p.overlay.setAttribute('role','dialog');p.overlay.setAttribute('aria-modal','true');p.overlay.setAttribute('aria-label',NAME);
        const panel=el('div','da-panel');p.overlay.append(panel);p.element=panel;
        const head=el('div','da-head'),brand=el('div','da-brand'),mark=el('div','da-brand-mark');
        // Fixed SVG only, never interpolated content from Discord.
        mark.innerHTML='<svg class="da-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 8h16v12H4zM3 4h18v4H3zM9 12h6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        const title=el('div');title.append(el('h2','',NAME));const sub=el('div','da-muted','Keep the conversations that matter.');sub.append(el('span','da-version','v'+VERSION));title.append(sub);brand.append(mark,title);
        p.hide=()=>{if(!this.live(p))return;this.persist(p);p.overlay.style.display='none';if(p.busy)this.bd.UI.showToast('Backup continues while this window is hidden. Keep Discord running.',{type:'info'});p.previousFocus?.focus?.();};
        head.append(brand,btn('Close',p.hide,'da-quiet'));panel.append(head);
        const serverSection=el('div','da-server-section'),serverLabel=el('label','da-field-label','Server');serverLabel.htmlFor='bdds-server';serverSection.append(serverLabel);
        const serverRow=el('div','da-server-row');p.serverAvatar=el('div','da-server-avatar',initials(guild?.name));p.server=el('select');p.server.id='bdds-server';p.server.setAttribute('aria-label','Server');
        p.refreshServers=()=>{
            const selected=p.gid||'';p.server.replaceChildren();const placeholder=el('option','', 'Choose a server…');placeholder.value='';p.server.append(placeholder);
            for(const g of this.owned()){const o=el('option','',g.name);o.value=String(g.id);p.server.append(o);}
            if(selected&&![...p.server.options].some(o=>o.value===selected)){const o=el('option','',(p.guild?.name||selected)+' — unavailable');o.value=selected;o.disabled=true;p.server.append(o);}
            p.server.value=selected;
        };
        p.server.onfocus=()=>{if(!p.busy&&!p.localBusy)p.refreshServers();};
        p.server.onchange=()=>this.switchServer(p,p.server.value);
        serverRow.append(p.serverAvatar,p.server);serverSection.append(serverRow);p.serverMeta=el('div','da-server-meta');serverSection.append(p.serverMeta);panel.append(serverSection);p.refreshServers();
        const folderLabel=el('label','da-field-label','Archive folder');folderLabel.htmlFor='bdds-folder';panel.append(folderLabel);
        const pathRow=el('div','da-path-row');p.folder=el('input');p.folder.id='bdds-folder';p.folder.type='text';p.folder.value=this.settings.folder;p.folder.placeholder='Choose a folder for your archives';p.folder.setAttribute('aria-label','Archive Folder');
        p.folder.oninput=()=>{p.archiveGeneration++;p.archive=null;p.archiveNote.textContent='Folder changed. Press Enter or leave this field to check saved data.';p.sync();};
        const setFolder=async()=>{
            if(!this.live(p)||p.busy)return;
            const value=p.folder.value.trim();if(!value||!path.isAbsolute(value)){this.notify(p,'Enter an absolute folder path or click Choose Folder.','warning');p.sync();return;}
            if(!this.persist(p))return;
            this.notify(p,'Archive folder selected. Each server is stored in its own Server ID subfolder.','success');await p.refreshSaved();await p.checkArchive();
        };
        p.folder.onchange=()=>{void setFolder();};p.folder.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();void setFolder();}};
        p.browse=btn('Choose Folder',()=>this.localAction(p,'folder',async()=>{
            this.notify(p,'Choose an archive folder in the folder picker.');
            const result=await this.bd.UI.openDialog({mode:'open',title:'Choose an Archive Folder',openDirectory:true,openFile:false,defaultPath:p.folder.value||undefined});
            if(!this.live(p))return;
            const folder=result?.filePaths?.[0];if(result?.canceled||!folder){this.notify(p,'Folder selection canceled. Your current folder has not changed.');return;}
            p.folder.value=folder;await setFolder();
        }));
        pathRow.append(p.folder,p.browse);panel.append(pathRow);p.archiveNote=el('div','da-local-note','Choose a server to check its local archive.');panel.append(p.archiveNote);
        const searchRow=el('div','da-row');p.search=el('input');p.search.type='search';p.search.placeholder='Search channels…';p.search.setAttribute('aria-label','Search channels');
        p.all=btn('Select All',()=>{
            if(!p.ready||p.busy)return this.notify(p,'Wait for a channel list before changing the selection.','warning');
            const visible=[...p.rows.values()].filter(r=>r.node.style.display!=='none');visible.forEach(r=>r.checkbox.checked=true);this.persist(p);p.sync();this.notify(p,`Selected ${fmt(visible.length)} ${p.search.value?'visible ':''}channels.`);
        });
        p.none=btn('Clear',()=>{if(p.busy)return;for(const r of p.rows.values())r.checkbox.checked=false;this.persist(p);p.sync();this.notify(p,'Channel selection cleared. Existing backup data was not deleted.');});
        p.reload=btn('Refresh Channels',()=>p.loadChannels());p.reload.title='Reload channels for the selected server. Switching servers loads them automatically.';
        searchRow.append(p.search,p.all,p.none,p.reload);panel.append(searchRow);
        const channelHeading=el('div','da-channel-heading');channelHeading.append(el('span','', 'CHANNELS'));p.selectionInfo=el('span');channelHeading.append(p.selectionInfo);panel.append(channelHeading);
        p.list=el('div','da-channel-list');p.list.append(el('div','da-empty','Choose a server above to load its channels.'));panel.append(p.list);
        const choices=el('div','da-choices');const checkbox=(label,value)=>{const l=el('label'),input=el('input');input.type='checkbox';input.checked=!!value;l.append(input,document.createTextNode(label));input.onchange=()=>{this.persist(p);this.notify(p,'Backup options updated. They apply to the next backup run.');};choices.append(l);return input;};
        p.files=checkbox('Download images and attachments',this.settings.files);p.threads=checkbox('Include threads and archived posts',this.settings.threads);panel.append(choices);
        p.status=el('div','da-status','Choose a server to get started.');p.status.setAttribute('role','status');p.status.setAttribute('aria-live','polite');panel.append(p.status);
        p.setStatus=(text,error=false)=>{if(!this.live(p))return;p.status.textContent=String(text);p.status.classList.toggle('da-error',error);};
        p.feedback=el('div','da-feedback');p.feedback.hidden=true;p.feedback.setAttribute('role','status');panel.append(p.feedback);
        const footer=el('div','da-footer');p.start=btn('Back Up / Resume',()=>this.beginJob(p,'backup'),'da-primary');
        p.pause=btn('Pause',()=>{if(!p.busy||p.operation!=='backup'||this.controller?.signal.aborted)return this.notify(p,'There is no running backup to pause.');this.controller.abort();p.sync();this.notify(p,'Pausing… Wait for the current write and lock release. You can switch servers after “Paused” is shown.');});
        p.openReader=btn('Open Offline Archive',()=>this.openArchive(p));p.openFolder=btn('Open Folder',()=>this.openFolder(p));footer.append(p.start,p.pause,p.openReader,p.openFolder);panel.append(footer);
        p.actionHint=el('div','da-action-hint');p.actionHint.id='bdds-action-hint';p.start.setAttribute('aria-describedby',p.actionHint.id);panel.append(p.actionHint);
        const details=el('details','da-details');details.append(el('summary','', 'Details / Troubleshooting'));p.log=el('pre');p.log.textContent='No backup has started in this window.';details.append(p.log);
        const actions=el('div','da-detail-actions');p.copy=btn('Copy Status',()=>this.copyStatus(p));p.rebuild=btn('Rebuild Reader',()=>this.beginJob(p,'rebuild'));p.rebuild.title='Update the offline reader using saved data. Message history is not downloaded again.';actions.append(p.copy,p.rebuild);details.append(actions);panel.append(details);
        panel.append(el('div','da-info','Read-only backup. Previously saved messages are kept if deleted on Discord. Only still-accessible history can be downloaded. Archives are not encrypted. User-account automation may violate Discord self-bot rules.'));
        p.sync=()=>{
            if(!this.live(p))return;
            const selected=[...p.rows.values()].filter(r=>r.checkbox.checked).length;
            const visible=[...p.rows.values()].filter(r=>r.node.style.display!=='none').length;
            const pathOK=!!p.folder.value.trim()&&path.isAbsolute(p.folder.value.trim());
            const locked=p.busy||p.localBusy;
            p.server.disabled=locked;p.browse.disabled=locked;p.folder.disabled=locked;p.reload.disabled=locked||p.loading||!p.gid;p.files.disabled=locked;p.threads.disabled=locked;
            p.all.disabled=locked||p.loading||!p.ready||!visible;p.none.disabled=locked||!selected;p.search.disabled=!p.gid;
            for(const r of p.rows.values())r.checkbox.disabled=locked||p.loading;
            let reason=!p.gid?'Choose a server above.':p.loading?'Loading channels for the selected server…':!p.ready?'Refresh the channel list to continue.':!pathOK?'Choose a valid archive folder.':!selected?'Select at least one channel to back up.':`Ready to back up ${fmt(selected)} selected channels. Existing history will be kept.`;
            if(locked)reason=p.operation==='backup'?(this.controller?.signal.aborted?'Saving the resume point. Server switching will unlock when the job stops.':'Backup is running. Pause before changing the server, folder, or selection.'):p.operation==='rebuild'?'Rebuilding the local reader. Please wait.':'Finishing the current local action…';
            p.start.disabled=locked||p.loading||!p.ready||!p.gid||!selected||!pathOK;p.start.title=reason;p.actionHint.textContent=reason;
            p.start.textContent=p.busy&&p.operation==='backup'?(this.controller?.signal.aborted?'Pausing…':'Backing Up…'):'Back Up / Resume';
            p.pause.disabled=!p.busy||p.operation!=='backup'||!!this.controller?.signal.aborted;p.pause.title='Pause safely and keep the resume point. Close only hides this window.';
            p.openReader.disabled=p.localBusy||p.operation==='rebuild';p.openReader.title='Open this server’s saved archive. Channel checkboxes only control the next backup.';
            p.openFolder.disabled=p.localBusy||p.operation==='rebuild';p.rebuild.disabled=locked||p.loading;
            p.browse.textContent=p.localOperation==='folder'?'Choosing…':'Choose Folder';p.openReader.textContent=p.localOperation==='reader'?'Opening…':'Open Offline Archive';p.openFolder.textContent=p.localOperation==='folder-open'?'Opening…':'Open Folder';p.rebuild.textContent=p.operation==='rebuild'?'Rebuilding…':'Rebuild Reader';
            p.selectionInfo.textContent=`${fmt(selected)} selected · ${fmt(visible)} / ${fmt(p.rows.size)} shown`;
            p.all.textContent=p.search.value.trim()?'Select Visible':'Select All';p.reload.textContent=p.loading?'Loading…':'Refresh Channels';
            p.serverMeta.textContent=locked?'Server switching is locked until the current action finishes.':p.gid?`${p.guild.name} · Owned server · Channels load automatically`:(p.server.options.length>1?'Only servers owned by your current Discord account are listed.':'No owned servers are currently available. Open a server you own in Discord, then reopen the selector.');
            p.status.classList.toggle('da-running',!!p.busy);
        };
        p.search.oninput=()=>{const q=p.search.value.trim().toLocaleLowerCase();for(const r of p.rows.values())r.node.style.display=r.channel.name.toLocaleLowerCase().includes(q)?'flex':'none';p.sync();};
        let savedGeneration=0;
        p.refreshSaved=async()=>{
            const gen=++savedGeneration;if(!p.gid)return;
            let root;try{root=this.root(p.gid,p.folder.value);}catch(_){for(const r of p.rows.values())r.status.textContent='Choose archive folder';return;}
            for(const [cid,r] of p.rows){
                try{const s=await readJSON(path.join(root,'channels',cid,'state.json'),null);if(!this.live(p)||gen!==savedGeneration)return;
                    if(s&&(!Array.isArray(s.parts)||String(s.id)!==cid))throw new Error('Invalid saved state');
                    const n=s?.parts?.reduce((n,x)=>n+(Number(x.count)||0),0)||0;r.status.textContent=s?`${fmt(n)} messages · ${s.run?'Paused / incomplete':s.error?'Needs attention':s.checkedAt?prettyDate(s.checkedAt):'Incomplete'}`:CONTAINERS.has(r.channel.type)?'Posts saved as threads':'Not backed up yet';
                }catch(_){if(this.live(p)&&gen===savedGeneration)r.status.textContent='Saved state needs attention';}
            }
        };
        p.checkArchive=async()=>{
            const gen=++p.archiveGeneration;if(!p.gid)return;
            try{const a=await this.inspectArchive(p.gid,p.folder.value);if(!this.live(p)||gen!==p.archiveGeneration)return;p.archive=a;p.archiveNote.classList.remove('da-warning');p.archiveNote.textContent=`Local archive: ${fmt(a.messages)} messages · ${fmt(a.channels)} saved channels${a.partial?' · Partial backup':''}${a.readerReady?'':' · Rebuild Reader to restore the viewer'}`;}
            catch(e){if(!this.live(p)||gen!==p.archiveGeneration)return;p.archive=null;p.archiveNote.textContent=e.message;p.archiveNote.classList.add('da-warning');}
        };
        const key=e=>{
            if(!this.live(p)||p.overlay.style.display==='none')return;
            if(e.key==='Escape'){e.stopPropagation();p.hide();return;}
            if(e.key==='Tab'){const controls=[...panel.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')].filter(n=>n.getClientRects().length);const first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
        };
        p.dispose=()=>{p.disposed=true;p.loadController.abort();p.archiveGeneration++;savedGeneration++;document.removeEventListener('keydown',key,true);p.overlay.remove();};
        document.addEventListener('keydown',key,true);document.body.append(p.overlay);
        p.loadChannels=async()=>{
            if(!this.live(p))return;if(!p.gid){this.notify(p,'Choose a server first.','warning');return;}
            if(p.busy||p.localBusy||p.loading){this.notify(p,'Wait for the current action to finish before refreshing channels.','warning');return;}
            if(!this.persist(p))return;p.ready=false;p.loading=true;p.lastErrorCode=null;p.feedback.hidden=true;p.channels=[];p.rows.clear();p.list.replaceChildren(el('div','da-empty','Loading channels…'));
            p.setStatus('Loading channels for '+p.guild.name+'…');p.sync();
            try{
                // Bind callbacks to this exact panel; old responses never update a new server.
                if(!p.client)p.client=new DiscordClient(this.bd,{onStatus:t=>{if(this.live(p))p.setStatus(t);}});
                const channels=await p.client.channels(p.gid,p.loadController.signal);if(!this.live(p)||p.loadController.signal.aborted)return;
                p.guild=this.bd.Webpack.getStore('GuildStore').getGuild(p.gid)||p.guild;p.serverAvatar.textContent=initials(p.guild.name);
                p.channels=channels;p.list.replaceChildren();const saved=this.settings.selected[p.gid]||[];let last=null;
                for(const c of channels){const category=c.category||'Channels';if(last!==category){last=category;p.list.append(el('div','da-category',category));}
                    const row=el('label','da-channel'),check=el('input');check.type='checkbox';check.checked=saved.includes(String(c.id));check.setAttribute('aria-label',c.name);
                    const status=el('span','da-channel-state','Checking saved data…');row.append(check,el('span','da-channel-name',(CONTAINERS.has(c.type)?'▤ ':[2,13].includes(c.type)?'◖ ':'# ')+c.name),status);
                    p.rows.set(String(c.id),{node:row,checkbox:check,status,channel:c});p.list.append(row);check.onchange=()=>{this.persist(p);p.sync();};
                }
                await p.refreshSaved();if(!this.live(p))return;
                p.ready=channels.length>0;if(!p.ready)p.list.append(el('div','da-empty','No supported text, voice, or forum channels were found.'));
                p.setStatus(p.ready?`Ready · ${fmt(channels.length)} channels found in ${p.guild.name}\nChoose channels, then click Back Up / Resume.`:'Channel list loaded, but no supported channels were found.');
                p.log.textContent=JSON.stringify(this.diagnostics(p),null,2);
            }catch(e){if(!this.live(p)||e.name==='AbortError')return;p.ready=false;p.rows.clear();p.channels=[];p.lastErrorCode=e.code||'HTTP_'+(e.status||'UNKNOWN');p.list.replaceChildren(el('div','da-empty','Channel loading failed. Click Refresh Channels to try again.'));p.setStatus('Could not load channels: '+e.message,true);p.log.textContent=JSON.stringify(this.diagnostics(p),null,2);}
            finally{if(this.live(p)){p.loading=false;p.search.oninput();p.sync();}}
        };
        p.sync();p.server.focus();if(p.gid){void p.loadChannels();void p.checkArchive();}return p;
    }
    diagnostics(p){return {...(p.client?.diagnostics()||{}),plugin:NAME,version:VERSION,runtime:runtimeSummary(),selectedServer:p.gid||null,selectedChannels:[...p.rows.values()].filter(r=>r.checkbox.checked).length,stage:p.operation|| (p.loading?'loading_channels':p.ready?'ready':'awaiting_selection'),errorCode:p.lastErrorCode||null,status:p.status.textContent,lastRun:p.lastRun||null};}
    async copyStatus(p){
        const text=JSON.stringify(this.diagnostics(p),null,2);p.log.textContent=text;let copied=false;
        try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);copied=true;}}catch(_){}
        if(!copied){const box=el('textarea');box.value=text;box.style.cssText='position:fixed;left:-9999px;top:0';p.element.append(box);box.select();try{copied=document.execCommand('copy');}catch(_){}box.remove();}
        if(copied)this.notify(p,'Status copied. Tokens and message contents are not included.','success');else{p.log.setAttribute('tabindex','0');p.log.focus();const r=document.createRange();r.selectNodeContents(p.log);const s=window.getSelection();s.removeAllRanges();s.addRange(r);this.notify(p,'Automatic copying was blocked. The status text is selected — press Ctrl+C.','warning');}
    }
    async localAction(p,kind,action){
        if(!this.live(p))return;if(p.localBusy||p.operation==='rebuild'||(p.busy&&kind==='folder')){this.notify(p,'Another local action is still running. Please wait.','warning');return;}
        p.lastErrorCode=null;p.localBusy=true;p.localOperation=kind;p.sync();try{await action();}catch(e){p.lastErrorCode=e.code||'DA_LOCAL_ACTION';this.notify(p,e.message,'warning');}finally{if(this.live(p)){p.localBusy=false;p.localOperation=null;p.sync();}}
    }
    async inspectArchive(gid,folder){
        const root=this.root(gid,folder);let info;try{info=await readJSON(path.join(root,'archive.json'),null);}catch(e){throw archiveError('Could not read archive metadata. Keep the archive and check the selected folder.\n'+e.message,'DA_ARCHIVE_INVALID');}
        if(!info)throw archiveError('No backup found for this server in the selected folder. Select channels and run Back Up / Resume first.','DA_NO_BACKUP');
        if(info.schema!==1||String(info.guild?.id)!==String(gid))throw archiveError('This folder does not contain a valid archive for the selected server.','DA_ARCHIVE_INVALID');
        let entries;try{entries=await fsp.readdir(path.join(root,'channels'));}catch(e){if(e.code==='ENOENT')throw archiveError('No channel data has been saved yet. Start or resume a backup first.','DA_NO_BACKUP');throw e;}
        let channels=0,messages=0,partial=['running','paused','partial','error'].includes(info.lastRun?.status),damaged=false;
        for(const cid of entries){if(!/^\d{1,22}$/.test(cid))continue;let s;try{s=await readJSON(path.join(root,'channels',cid,'state.json'),null);}catch(_){damaged=true;continue;}
            if(!s||s.schema!==1||String(s.id)!==cid||!Array.isArray(s.parts)){if(s)damaged=true;continue;}
            let readable=0;
            for(const part of s.parts){if(!part||!new RegExp('^channels/'+cid+'/parts/\\d{1,22}-\\d{1,22}\\.js$').test(part.file)||!Number.isInteger(part.count)||part.count<1){damaged=true;continue;}
                try{const st=await fsp.stat(path.join(root,...part.file.split('/')));if(!st.isFile()||(part.bytes!=null&&st.size!==part.bytes)){damaged=true;continue;}readable+=part.count;}catch(_){damaged=true;}
            }
            const emptyComplete=s.parts.length===0&&s.historyComplete&&!!s.checkedAt;
            if(readable||emptyComplete){channels++;messages+=readable;}
            if(s.run||s.error||!s.historyComplete||s.parts.some(x=>x?.pending>0))partial=true;
        }
        if(!channels)throw archiveError(damaged?'Saved channel data is missing or invalid. Do not delete the archive; check the selected folder and backup details.':'No channel history has been saved yet. Start or resume a backup first.',damaged?'DA_ARCHIVE_INVALID':'DA_NO_BACKUP');
        let readerReady=true;for(const file of ['index.html','viewer.js','viewer.css','catalog.js']){try{const st=await fsp.stat(path.join(root,file));if(!st.isFile()||!st.size)readerReady=false;}catch(_){readerReady=false;}}
        return {root,channels,messages,partial:partial||damaged,readerReady};
    }
    async shellOpen(target){
        const shell=require('electron').shell;if(typeof shell?.openPath!=='function')throw archiveError('Automatic opening is unavailable. Open this path in File Explorer:\n'+target,'DA_OPEN_UNAVAILABLE');
        const error=await shell.openPath(target);if(error)throw archiveError('The operating system could not open this path:\n'+target+'\n'+error,'DA_OPEN_FAILED');
    }
    async openArchive(p){return this.localAction(p,'reader',async()=>{
        this.notify(p,'Checking the local archive…');const a=await this.inspectArchive(p.gid,p.folder.value);if(!this.live(p))return;
        if(!a.readerReady)throw archiveError('Saved data exists, but reader files are missing. Open Details / Troubleshooting and click Rebuild Reader.','DA_READER_MISSING');
        await this.shellOpen(path.join(a.root,'index.html'));this.notify(p,`Opened the offline archive for ${p.guild.name}.${a.partial?' This is a partial backup; only saved data is available.':''}`,'success');
    });}
    async openFolder(p){return this.localAction(p,'folder-open',async()=>{
        this.notify(p,'Checking the server archive folder…');const root=this.root(p.gid,p.folder.value);let st;try{st=await fsp.stat(root);}catch(e){if(e.code==='ENOENT')throw archiveError('No backup folder exists for this server yet. Run Back Up / Resume first.','DA_NO_BACKUP_FOLDER');throw e;}
        if(!st.isDirectory())throw archiveError('The server archive path is not a folder.','DA_ARCHIVE_INVALID');await this.shellOpen(root);this.notify(p,'Opened server archive folder:\n'+root,'success');
    });}
    async confirmUnlock(root){
        const p=this.panel,display=p?.overlay.style.display;if(p)p.overlay.style.display='none';
        try{return await new Promise(resolve=>this.bd.UI.showConfirmationModal('Archive lock found',
            'Archive: '+root+'\nContinue only after confirming no other Discord window is writing to this archive. Only the lock is replaced; saved data is not deleted.',
            {confirmText:'No other job — Continue',cancelText:'Cancel',onConfirm:()=>resolve(true),onCancel:()=>resolve(false),onClose:()=>Promise.resolve().then(()=>resolve(false))}));}
        finally{if(this.live(p)&&p.overlay.isConnected)p.overlay.style.display=display||'flex';}
    }
    async beginJob(p,kind){
        if(!this.live(p))return;if(p.busy||p.localBusy||p.loading||this.jobPromise){this.notify(p,'Wait for the current action to finish before starting another one.','warning');return;}
        if(!p.gid){this.notify(p,'Choose a server first.','warning');return;}
        let root;try{root=this.root(p.gid,p.folder.value);}catch(e){this.notify(p,e.message,'warning');return;}
        const selected=[...p.rows.values()].filter(r=>r.checkbox.checked).map(r=>({...r.channel}));
        if(kind==='backup'&&(!p.ready||!selected.length)){this.notify(p,'Select at least one loaded channel to back up.','warning');return;}
        if(!this.persist(p))return;
        const spec={gid:p.gid,guild:{id:p.gid,name:p.guild.name},root,selected,files:p.files.checked,threads:p.threads.checked,client:p.client};
        p.lastErrorCode=null;if(kind==='backup')p.lastRun=null;p.busy=true;p.operation=kind;p.feedback.hidden=true;this.controller=new AbortController();p.sync();
        const job=(async()=>{
            try{if(kind==='rebuild')await this.rebuild(p,spec,this.controller.signal);else await this.run(p,spec,this.controller.signal);}
            catch(e){if(this.live(p)){p.lastErrorCode=e.code||'DA_JOB_FAILED';p.setStatus(e.message,true);this.notify(p,e.message,'error');}}
            finally{if(this.live(p)){await p.refreshSaved();await p.checkArchive();}}
        })();
        this.jobPromise=job;
        try{await job;}finally{if(this.jobPromise===job){this.jobPromise=null;this.controller=null;}if(this.live(p)){p.busy=false;p.operation=null;if(kind==='backup'&&p.lastRun?.status==='paused')this.notify(p,'Paused. The resume point is saved; you can resume or switch servers.','success');p.sync();}}
    }
    saveReaderLayout(disk,p,selected=[]){
        if(!Array.isArray(p.client?.channelLayout))return;
        const source=p.client.channelLayout,byId=new Map(source.map(c=>[String(c.id),c])),needed=new Set([...disk.states.keys(),...selected.map(c=>String(c.id))]);
        for(const s of disk.states.values())if(s.parentId)needed.add(String(s.parentId));
        for(const cid of needed){const parent=byId.get(cid)?.parentId;if(parent)needed.add(String(parent));}
        disk.info.channelLayout={schema:1,updatedAt:now(),channels:source.filter(c=>needed.has(String(c.id)))};
    }
    async rebuild(p,spec,signal){
        p.setStatus('Checking saved data before rebuilding the reader…');await this.inspectArchive(spec.gid,path.dirname(spec.root));if(signal.aborted)throw archiveError('Rebuild canceled.');
        const disk=new DiskArchive(spec.root,spec.guild,assets,{confirmUnlock:root=>this.confirmUnlock(root)});
        try{await disk.acquire();if(signal.aborted)throw archiveError('Rebuild canceled.');p.setStatus('Rebuilding the offline reader…');await disk.init();this.saveReaderLayout(disk,p);await disk.publish();p.setStatus(`Reader updated to v${VERSION}. Message data and resume points were kept.\nOpen Offline Archive to view it. No message history was downloaded.`);}
        finally{await disk.release();}
    }
    async run(p,spec,signal){
        const disk=new DiskArchive(spec.root,spec.guild,assets,{confirmUnlock:root=>this.confirmUnlock(root)});let initialized=false,total=0,done=0,failed=0,current='',added=0;const failures=[],started=now();
        try{
            p.setStatus('Preparing the archive folder…');await disk.acquire();if(signal.aborted)throw Object.assign(new Error('Paused — resume point kept.'),{name:'AbortError'});
            await disk.init();initialized=true;this.saveReaderLayout(disk,p,spec.selected);
            disk.info.scope={selectedChannels:spec.selected.map(c=>({id:c.id,name:c.name,type:c.type})),includeThreads:spec.threads,downloadFiles:spec.files};disk.info.warnings=[];disk.info.lastRun={status:'running',startedAt:started};await disk.publish();
            await spec.client.assertOwner(spec.gid,signal);
            const discovered=await spec.client.discover(spec.gid,spec.selected,spec.threads,signal,text=>p.setStatus(text));total=discovered.channels.length;disk.info.warnings=discovered.warnings;await disk.publish();
            const engine=new HistoryEngine(disk,spec.client,{signal,files:spec.files,onProgress:s=>{
                added=s.added;const stage={messages:'Reading older messages',files:'Downloading attachments',done:'Channel saved',paused:'Pausing',error:'Error'}[s.stage]||s.stage;
                p.setStatus(`${stage} · #${s.channel}\nChannels ${fmt(done+failed)} / ${fmt(total)} · Added ${fmt(s.added)} messages · Saved in this channel ${fmt(s.total)} · Pending files ${fmt(s.pending)}`+(s.filename?'\n'+s.filename:''));
                const row=p.rows.get(s.channelId);if(row)row.status.textContent=`${fmt(s.total)} messages · ${stage}`;
            }});
            for(const c of discovered.channels){if(signal.aborted)break;current=c.name;try{await engine.backup(c);done++;}catch(e){if(e.name==='AbortError')break;failed++;failures.push(`#${c.name}: ${e.message}`);if(isDiskError(e)||e.status===401||e.fatal)throw e;}}
            const targets=new Set(discovered.channels.map(c=>String(c.id))),pending=[...disk.states.values()].filter(s=>targets.has(s.id)).reduce((n,s)=>n+s.parts.reduce((a,x)=>a+x.pending,0),0),paused=signal.aborted;
            disk.info.lastRun={status:paused?'paused':failed||discovered.warnings.length||pending?'partial':'done',startedAt:started,finishedAt:now(),channels:total,done,failed,added,pendingFiles:pending};
            disk.info.warnings=[...discovered.warnings,...failures];await disk.publish();p.lastRun={...disk.info.lastRun};
            p.setStatus(`${paused?'Paused — resume point saved':failed||discovered.warnings.length?'Partially completed — see details':pending?'Messages saved — attachments are incomplete':'Backup completed'}\nChannels saved ${fmt(done)} / ${fmt(total)} · New messages ${fmt(added)} · Missing files ${fmt(pending)}`,!!failed||!!discovered.warnings.length);
            p.log.textContent=JSON.stringify({...this.diagnostics(p),lastRun:p.lastRun,warnings:disk.info.warnings},null,2);await atomicWrite(disk.resolve('diagnostics.json'),p.log.textContent);
            if(this.enabled)this.bd.UI.showToast(paused?'Backup paused. Resume point saved.':failed||pending||discovered.warnings.length?'Backup finished with incomplete items. Check Details.':'Backup completed.',{type:failed||pending||discovered.warnings.length?'warning':'success'});
        }catch(e){
            const paused=e.name==='AbortError'||signal.aborted,text=paused?'Paused — saved data and resume points were kept.':e.message;p.lastErrorCode=paused?null:e.code||'DA_BACKUP_FAILED';p.setStatus(text,!paused);
            p.lastRun={status:paused?'paused':'error',startedAt:started,finishedAt:now(),done,failed,added,error:text};if(initialized){disk.info.lastRun={...p.lastRun};await disk.publish().catch(()=>{});}
            p.log.textContent=JSON.stringify({...this.diagnostics(p),channel:current,error:text},null,2);if(initialized)await atomicWrite(disk.resolve('diagnostics.json'),p.log.textContent).catch(()=>{});
        }finally{await disk.release();}
    }
};

}
};
const __cache={};
function __load(name){if(__cache[name])return __cache[name].exports;if(!__factories[name])return require(name);const m={exports:{}};__cache[name]=m;__factories[name](m,m.exports,__load);return m.exports;}
module.exports=__load("./plugin");
