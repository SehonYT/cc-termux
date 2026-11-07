#!/usr/bin/env node
import http from 'node:http';
let n = 0;
const log=(...a)=>console.error(new Date().toISOString(),...a);
http.createServer((req,res)=>{
 let raw=''; req.on('data',c=>raw+=c); req.on('end',()=>{
  n++;
  if (n <= 2) { log('503 attempt', n); res.writeHead(503,{'content-type':'application/json','retry-after':'1'}); return res.end('{"error":"model is under load"}'); }
  log('200 attempt', n);
  res.writeHead(200,{'content-type':'text/event-stream'});
  const ev=(d)=>res.write('data: '+JSON.stringify(d)+'\n\n');
  ev({choices:[{delta:{content:'RETRY_OK'},finish_reason:null,index:0}]});
  ev({choices:[{delta:{},finish_reason:'stop',index:0}],usage:{prompt_tokens:10,completion_tokens:2}});
  res.end('data: [DONE]\n\n');
 });
}).listen(8896,'127.0.0.1',()=>log('mock retry upstream 8896'));