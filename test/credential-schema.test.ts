import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { z } from "zod";

type SchemaNode = {
  properties?: Record<string, SchemaNode>;
  $defs?: Record<string, SchemaNode>;
  oneOf?: SchemaNode[];
};

function properties(node: SchemaNode): SchemaNode[] {
  const own = Object.values(node.properties ?? {});
  return [...own, ...[...own, ...Object.values(node.$defs ?? {}), ...node.oneOf ?? []].flatMap(properties)];
}

test("every credential schema property supplies non-blank form labels and help", () => {
  const schema = JSON.parse(readFileSync(new URL("../axi-credential.schema.json", import.meta.url), "utf8"));
  const metadata = z.array(z.object({ title: z.string().trim().min(1), description: z.string().trim().min(1) })).min(1);
  expect(metadata.safeParse(properties(schema)).success).toBe(true);
});
