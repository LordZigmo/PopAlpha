import { SignIn } from "@clerk/nextjs";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <main className="app-shell min-h-screen flex items-center justify-center p-6 text-app">
      <div className="w-full max-w-md">
        <div className="mb-5">
          <h1 className="text-3xl font-semibold tracking-tight">PopAlpha</h1>
          <p className="text-muted mt-1 text-sm">Sign in to your account.</p>
        </div>
        <SignIn
          fallbackRedirectUrl="/"
          appearance={{
            elements: {
              rootBox: "w-full",
              card: "bg-transparent shadow-none border-none p-0",
            },
          }}
        />
      </div>
    </main>
  );
}
