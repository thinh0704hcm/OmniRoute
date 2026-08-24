import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { bindVolcenginePlansFromConsoleCredentials } from "@/lib/providers/volcenginePlanBinding";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

const selectIdentitySchema = z.object({
  index: z.coerce.number().int().nonnegative(),
  timeout: z.number().optional(),
});

/**
 * POST /api/providers/volcengine-plan/connect/[sessionId]/identity
 * Pick an identity on the console's select_identity page (the phone maps to
 * multiple accounts) and finish the login + plan binding.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
): Promise<NextResponse> {
  const auth = await requireManagementAuth(request);
  if (auth) return auth;

  const { sessionId } = await params;
  const parsed = selectIdentitySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid identity index" }, { status: 400 });
  }
  const body = parsed.data;

  try {
    const { volcengineConsoleAutoLoginService } =
      await import("@omniroute/open-sse/services/volcengineConsoleAutoLogin.ts");

    if (!volcengineConsoleAutoLoginService.getStatus(sessionId)) {
      return NextResponse.json(
        { success: false, error: "Unknown or expired Volcano login session" },
        { status: 404 }
      );
    }

    const timeout = body.timeout;
    const session = await volcengineConsoleAutoLoginService.selectIdentity(sessionId, body.index, {
      timeout,
    });
    if (!session) {
      return NextResponse.json(
        { success: false, error: "Unknown or expired Volcano login session" },
        { status: 404 }
      );
    }

    // Credentials ready → bind immediately so the response carries the outcome.
    if (session.phase === "success") {
      const bound = await volcengineConsoleAutoLoginService.withBinding(sessionId, (credentials) =>
        bindVolcenginePlansFromConsoleCredentials(credentials)
      );
      return NextResponse.json({ success: true, session: bound ?? session });
    }

    return NextResponse.json({ success: false, session });
  } catch (error) {
    const message = sanitizeErrorMessage(error instanceof Error ? error.message : error);
    return NextResponse.json(
      { success: false, error: `Volcano identity selection failed: ${message}` },
      { status: 500 }
    );
  }
}
