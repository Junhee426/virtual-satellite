export const DEFAULTS=Object.freeze({nodes:16,formation:'Grid',baselineM:500,rangeKm:550,freqGHz:20,totalPowerW:320,powerMode:'Total fixed',pathErrorMm:0,rfPhaseRmsDeg:0,freqOffsetHz:0,command:'Estimated',seed:426,mapSpanKm:10,lossTargetDb:1,timeS:0});
export const LIMITS={nodes:[1,64],baselineM:[1,5000],rangeKm:[100,50000],freqGHz:[.1,100],totalPowerW:[.1,100000],pathErrorMm:[0,1000],rfPhaseRmsDeg:[0,180],freqOffsetHz:[0,10000],seed:[0,4294967295],mapSpanKm:[.0001,100],lossTargetDb:[.01,12],timeS:[0,100]};
const OPTIONS={formation:['Grid','Ring','Line','Random'],powerMode:['Total fixed','Per node'],command:['Estimated','Oracle','None']};
export function normalizeConfig(input={},base=DEFAULTS){
 const result={...base};
 if(!input||typeof input!=='object'||Array.isArray(input))return result;
 for(const [key,[min,max]] of Object.entries(LIMITS)){
  if(typeof input[key]!=='number'||!Number.isFinite(input[key]))continue;
  result[key]=Math.min(max,Math.max(min,input[key]));
  if(key==='nodes'||key==='seed')result[key]=Math.round(result[key]);
 }
 for(const [key,options] of Object.entries(OPTIONS))if(options.includes(input[key]))result[key]=input[key];
 return result;
}
export const phaseDegrees=a=>Math.atan2(Math.sin(a),Math.cos(a))*180/Math.PI;
export const expectedCoherence=(n,phaseRmsDeg)=>1/n+(1-1/n)*Math.exp(-((phaseRmsDeg*Math.PI/180)**2));
