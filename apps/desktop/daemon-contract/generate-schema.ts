import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeDaemonRpcContractDocument } from "./schema-document.js";

const outputPath = join(dirname(fileURLToPath(import.meta.url)), "rpc-contract.schema.json");
writeFileSync(outputPath, serializeDaemonRpcContractDocument(), "utf8");
console.log(`Wrote ${outputPath}`);
