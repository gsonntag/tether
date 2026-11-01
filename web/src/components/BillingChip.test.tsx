import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionApiCostGroup } from "./SessionApiCostGroup";

test("the billing dropdown shows estimated partial API spend as a lower bound", () => {
  const html = renderToStaticMarkup(
    <SessionApiCostGroup billing={{ kind: "apiKey", label: "OpenAI API key" }} cost={{ usd: 0.02, estimated: true, complete: false, reasons: ["no-cache-ttl"] }} />,
  );

  expect(html).toContain("API key spend this session");
  expect(html).toContain("est. $0.02");
  expect(html).toContain("Known API subtotal $0.02 estimated");
  expect(html).toContain("not the session");
  expect(html).toContain("lower bound");
});

test("the billing dropdown labels missing API cost as unknown", () => {
  const html = renderToStaticMarkup(<SessionApiCostGroup billing={{ kind: "apiKey", label: "OpenAI API key" }} cost={undefined} />);
  expect(html).toContain("Cost unknown");
});

test("a subscription session with no API history has no API spend group", () => {
  const html = renderToStaticMarkup(<SessionApiCostGroup billing={{ kind: "plan", label: "ChatGPT plan" }} cost={undefined} />);
  expect(html).toBe("");
});

test("a subscription session retains API spend from an earlier key period", () => {
  const html = renderToStaticMarkup(<SessionApiCostGroup billing={{ kind: "plan", label: "ChatGPT plan" }} cost={{ usd: 0.02, estimated: true, complete: true }} />);
  expect(html).toContain("API key spend this session");
  expect(html).toContain("est. $0.02");
});
