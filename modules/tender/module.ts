// 招采申报的地址：列表页，以及它读的接口。
import { defineModule } from "@aihot/contracts/modules";

export const tender = defineModule({
  name: "tender",
  pages: [{ path: "procurement", file: "web/list.tsx" }],
  apiPaths: [/^\/api\/site\/procurement(?:\/|$)/],
});
