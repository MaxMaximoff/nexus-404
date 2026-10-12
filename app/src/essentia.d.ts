// essentia.js ships no types for its ES builds; only what sp404/essentiaKey.ts uses.
declare module "essentia.js/dist/essentia.js-core.es.js" {
  export default class Essentia { constructor(wasm: unknown); version: string }
}
declare module "essentia.js/dist/essentia-wasm.es.js" {
  export const EssentiaWASM: unknown;
}
