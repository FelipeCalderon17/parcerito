// Renders assets/parcerito.svg to the PNGs Slack and GitHub need (Slack wants 512–2000px, square).
import fs from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const svg = fs.readFileSync(new URL("../assets/parcerito.svg", import.meta.url));
for (const size of [1024, 128]) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  const out = new URL(`../assets/parcerito-${size}.png`, import.meta.url);
  fs.writeFileSync(out, png);
  console.log(`wrote ${out.pathname}`);
}
