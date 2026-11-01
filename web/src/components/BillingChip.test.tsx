import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionApiCostGroup } from "./SessionApiCostGroup";

test("the billing dropdown shows estimated partial API spend as a lower bound", () => {
  const html = renderToStaticMarkup(
    <SessionApiCostGroup cost={{ usd: 0.02, estimated: true, complete: false, reasons: ["no-cache-ttl"] }} />,
  );

  expect(html).toContain("API key spend this session");
  expect(html).toContain("~$0.02+ est.");
  expect(html).toContain("Known API subtotal $0.02 estimated");
  expect(html).toContain("not the session");
  expect(html).toContain("lower bound");
});

test("the billing dropdown labels missing API cost as unknown", () => {
  const html = renderToStaticMarkup(<SessionApiCostGroup cost={undefined} />);
  expect(html).toContain("Cost unknown");
});
