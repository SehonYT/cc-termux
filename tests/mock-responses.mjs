#!/usr/bin/env node
import http from 'node:http';
const log=(...a)=>console.error(new Date().toISOString(),...a);
const ev=(res,t,d)=>res.write('event: '+t+'\ndata: '+JSON.stringify({type:t,...d})+'\n\n');
http.createServer((req,res)=>{
 let raw=''; req.on('data',c=>raw+=c); req.on('end',()=>{
  let b={}; try{b=JSON.parse(raw||'{}')}catch{}
  const input=b.input||[];
  const toolOut=input.filter(i=>i.type==='function_call_output');
  log('REQ', req.url, 'model='+b.model, 'tools='+(b.tools||[]).length, 'stream='+!!b.stream, 'items='+input.length, 'toolOut='+toolOut.length);
  const model=b.model||'m';
  if(toolOut.length){
   const text='RESP FINAL '+String(toolOut[toolOut.length-1].output).trim();
   if(b.stream){ res.writeHead(200,{'content-type':'text/event-stream'});
    ev(res,'response.output_text.delta',{delta:text});
    ev(res,'response.completed',{response:{id:'resp_2',usage:{input_tokens:100,output_tokens:5},output:[]}});
    res.end();
   } else { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({id:'resp_2',output:[{type:'message',content:[{type:'output_text',text}]}],usage:{input_tokens:100,output_tokens:5}})); }
   return; }
  if(b.stream){ res.writeHead(200,{'content-type':'text/event-stream'});
   ev(res,'response.output_item.added',{item:{type:'function_call',id:'fc_1',call_id:'call_1',name:'Bash',arguments:''}});
   ev(res,'response.function_call_arguments.delta',{item_id:'fc_1',delta:JSON.stringify({command:'echo hi-from-tool',description:'t'})});
   ev(res,'response.completed',{response:{id:'resp_1',usage:{input_tokens:100,output_tokens:20},output:[{type:'function_call'}]}});
   res.end();
  } else { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({id:'resp_1',output:[{type:'function_call',call_id:'call_1',name:'Bash',arguments:JSON.stringify({command:'echo hi-from-tool'})}],usage:{input_tokens:100,output_tokens:20}})); }
 });
}).listen(8897,'127.0.0.1',()=>log('mock responses upstream on 8897'));