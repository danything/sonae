// Blades の部品は CSS だけで、名前が .css で終わらないので vite/client の "*.css" に当たらない。
// TypeScript 6 からは副作用だけの import も解決先を確かめる(noUncheckedSideEffectImports)ので、
// コンポーネントで import "@anyblades/blades/<部品>"; と書くと svelte-check が落ちる。型は無いと宣言しておく
declare module "@anyblades/blades/*";
