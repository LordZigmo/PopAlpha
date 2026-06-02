export function GET(request: Request) {
  return Response.redirect(new URL("/icon?v=5", request.url), 307);
}
