import fs from 'node:fs';
const root=new URL('../',import.meta.url);
const target=new URL('public/audio/',root);fs.mkdirSync(target,{recursive:true});
let code=fs.readFileSync(new URL('node_modules/spessasynth_lib/dist/spessasynth_processor.min.js',root),'utf8');
// Public MessagePort adapter: a cancellable timestamp queue, no private synth access.
let count=0;
code=code.replace(/registerProcessor\((\w+),(\w+)\);/g,(_match,name,base)=>{count++;return `
class LooperProcessor extends ${base} {
 constructor(options){super(options);this.pending=[];this.traceSeq=0;
  // The library installs onmessage asynchronously. A capture listener survives that
  // assignment and intercepts custom/queued messages before the library handler.
  this.deliver=message=>this.port.onmessage?.call(this.port,{data:message});
  this.port.addEventListener('message',event=>{const m=event.data;
   if(m.type==='looperClear'){
    event.stopImmediatePropagation();this.pending.length=0;this.deliver({type:'stopAll',channelNumber:-1,data:1});return;
   }
   if(m.type==='looperClearTrack'){
    event.stopImmediatePropagation();const queuedBefore=this.pending.length;
    this.pending=this.pending.filter(p=>((p.data.messageData[0]&15)+(p.data.channelOffset||0))!==m.channel);
    for(const cc of [64,66,67,69,120,121])this.deliver({type:'midiMessage',channelNumber:-1,data:{messageData:[176|m.channel,cc,0],channelOffset:0,options:{time:0}}});
    this.deliver({type:'midiMessage',channelNumber:-1,data:{messageData:[224|m.channel,0,64],channelOffset:0,options:{time:0}}});
    this.port.postMessage({type:'looperTrace',seq:++this.traceSeq,kind:'clear-applied',channel:m.channel,audioTime:currentTime,queuedBefore,queuedAfter:this.pending.length});return;
   }
   if(m.type==='midiMessage'&&m.data.options.time>currentTime){event.stopImmediatePropagation();this.pending.push(m);this.pending.sort((a,b)=>a.data.options.time-b.data.options.time);}
  },{capture:true});
  this.port.start();
 }
 process(inputs,outputs,parameters){while(this.pending[0]?.data.options.time<=currentTime){const m=this.pending.shift();m.data.options.time=0;this.deliver(m);}return super.process(inputs,outputs,parameters);}
}
registerProcessor(${name},LooperProcessor);`;});
if(count!==1)throw Error('Unexpected SpessaSynth registration; review the adapter before upgrading.');
code=code.replace(/\/\/# sourceMappingURL=.*$/m,'');
fs.writeFileSync(new URL('looper-processor.js',target),'/* SpessaSynth (Apache-2.0), with Audio Looper cancellable MIDI MessagePort adapter. */\n'+code);
for(const [folder,name]of [['spessasynth_lib','SpessaSynth-LICENSE.txt'],['spessasynth_core','SpessaSynthCore-LICENSE.txt']])
 fs.copyFileSync(new URL(`node_modules/${folder}/LICENSE`,root),new URL(name,target));
console.log('AudioWorklet and licenses synchronized.');
