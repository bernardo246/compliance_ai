// `file-type` é ESM-only (usa `exports` condicional só com "import").
// Com moduleResolution "node" (padrão do template Nest/CommonJS), o
// TypeScript não resolve os tipos desse pacote em tempo de build mesmo
// usando dynamic import(). Declaramos o módulo como `any` aqui para não
// termos que migrar o projeto inteiro para moduleResolution "bundler"/
// "nodenext" só por causa de uma dependência. O import em si continua
// sendo feito via `await import('file-type')` em runtime (Node resolve
// ESM dinamicamente sem problema).
declare module 'file-type';
