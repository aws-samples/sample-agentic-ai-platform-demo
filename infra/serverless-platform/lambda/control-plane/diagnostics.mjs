const stages=new Set(['registry-list','registry-detail','registry-batch','registry-projection','registry-read','domain-selection','operation-deadline','unknown']);
const codes=new Set(['ACCESS_DENIED','THROTTLED','TIMEOUT','ABORTED','NOT_FOUND','VALIDATION','SERVICE_UNAVAILABLE','UNKNOWN']);
const names=new Map([
 ['AccessDeniedException','ACCESS_DENIED'],['UnauthorizedException','ACCESS_DENIED'],
 ['ThrottlingException','THROTTLED'],['TooManyRequestsException','THROTTLED'],
 ['TimeoutError','TIMEOUT'],['RequestTimeout','TIMEOUT'],['RequestTimeoutException','TIMEOUT'],
 ['AbortError','ABORTED'],['ResourceNotFoundException','NOT_FOUND'],['NotFoundException','NOT_FOUND'],
 ['ValidationException','VALIDATION'],['ServiceUnavailableException','SERVICE_UNAVAILABLE'],['InternalServerException','SERVICE_UNAVAILABLE'],
]);
const annotations=new WeakMap();
const object=e=>e!==null&&(typeof e==='object'||typeof e==='function');
export function safeDiagnostic(value){
 return {stage:stages.has(value?.stage)?value.stage:'unknown',errorCode:codes.has(value?.errorCode)?value.errorCode:'UNKNOWN'};
}
export function errorDiagnostic(error,stage='unknown'){
 if(object(error)&&annotations.has(error))return annotations.get(error);
 let name;try{const d=Object.getOwnPropertyDescriptor(error,'name');if(d&&Object.hasOwn(d,'value'))name=d.value}catch{}
 return safeDiagnostic({stage,errorCode:names.get(name)||'UNKNOWN'});
}
export async function diagnosticStage(stage,operation){
 try{return await operation()}catch(error){if(object(error)&&!annotations.has(error))annotations.set(error,errorDiagnostic(error,stage));throw error}
}
export function deadlineDiagnostic(error){if(object(error))annotations.set(error,{stage:'operation-deadline',errorCode:'TIMEOUT'});return error}
