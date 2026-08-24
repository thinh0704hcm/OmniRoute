import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { bindVolcenginePlansFromConsoleCredentials } from "@/lib/providers/volcenginePlanBinding";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

const connectSchema = z.object({
  phone: z.string().optional(),
  timeout: z.number().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireManagementAuth(request);
  if (auth) return auth;

  const parsed = connectSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }
  const body = parsed.data;
  const timeout = body.timeout;

  // Auto flow: phone present → start a session-based headless phone/SMS login.
  if (body.phone?.trim()) {
    try {
      const { volcengineConsoleAutoLoginService } =
        await import("@omniroute/open-sse/services/volcengineConsoleAutoLogin.ts");
      const started = await volcengineConsoleAutoLoginService.startLogin(body.phone, { timeout });
      if (!started.ok) {
        return NextResponse.json({ success: false, error: started.error }, { status: 400 });
      }
      return NextResponse.json({ success: true, session: started.session });
    } catch (error) {
      const message = sanitizeErrorMessage(error instanceof Error ? error.message : error);
      return NextResponse.json(
        { success: false, error: `Volcano auto login failed to start: ${message}` },
        { status: 500 }
      );
    }
  }

  // Legacy manual flow: headful browser login on the server machine.
  try {
    const { inAppLoginService } = await import("@omniroute/open-sse/services/inAppLoginService.ts");
    const login = await inAppLoginService.startLogin("volcengine-console", { timeout });
    if (!login.success || !login.credentials) {
      return NextResponse.json(
        { success: false, error: login.error || "Volcano console login failed" },
        { status: 400 }
      );
    }

    const binding = await bindVolcenginePlansFromConsoleCredentials(login.credentials);
    return NextResponse.json({ success: true, binding });
  } catch (error) {
    const message = sanitizeErrorMessage(error instanceof Error ? error.message : error);
    return NextResponse.json(
      { success: false, error: `Volcano account binding failed: ${message}` },
      { status: 500 }
    );
  }
}
