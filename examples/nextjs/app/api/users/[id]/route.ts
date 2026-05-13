import { readExampleUser } from "../../../lib/brass.server";

type RouteContext = {
  readonly params: Promise<{ readonly id: string }> | { readonly id: string };
};

export async function GET(_request: Request, context: RouteContext) {
  const params = await context.params;
  const user = await readExampleUser(params.id);

  return Response.json({ user });
}

