export function GET(request: Request) {
  return Response.redirect(new URL("/icon?v=3", request.url), 307);
}
