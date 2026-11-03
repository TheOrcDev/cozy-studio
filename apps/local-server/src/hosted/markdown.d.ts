// Markdown imported `with { type: 'text' }`, which the Neon Function bundler inlines as a string.
declare module '*.md' {
  const text: string;
  export default text;
}
