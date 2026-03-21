import { auth } from "@/auth";

export const proxy = auth((req) => {
  // Allow auth routes (needed for OAuth flow)
  if (req.nextUrl.pathname.startsWith("/api/auth")) return;

  // Redirect unauthenticated users to sign-in
  if (!req.auth) {
    const signIn = new URL("/api/auth/signin", req.nextUrl.origin);
    signIn.searchParams.set("callbackUrl", req.nextUrl.href);
    return Response.redirect(signIn);
  }
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
