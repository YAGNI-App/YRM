// The dashboard's static files are imported `with { type: "text" }` so a
// compiled binary embeds them. This tells TypeScript what a CSS import is.
declare module "*.css" {
  const text: string;
  export default text;
}
