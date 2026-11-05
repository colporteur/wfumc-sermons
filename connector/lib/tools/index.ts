// Every tool the connector offers. Write tools appear only on connections
// Todd approved with "Allow changes".

import type { ToolDef } from "../protocol";
import type { Ctx } from "./util";
import { sermonTools } from "./sermons";
import { slideTools } from "./slides";
import { resourceTools } from "./resources";
import { liturgyTools } from "./liturgies";
import { contextTools } from "./context";
import { changeTools } from "./changes";

export function allTools(ctx: Ctx): ToolDef[] {
  const tools = [
    ...sermonTools(ctx),
    ...slideTools(ctx),
    ...resourceTools(ctx),
    ...liturgyTools(ctx),
    ...contextTools(),
    ...changeTools(ctx),
  ];
  return ctx.write ? tools : tools.filter((t) => t.readOnly !== false);
}
