import { SignUp } from "@clerk/nextjs";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  return (
    <main className="app-shell min-h-screen flex items-center justify-center p-6 text-app">
      <div className="w-full max-w-md">
        <div className="mb-5">
          <h1 className="text-3xl font-semibold tracking-tight">PopAlpha</h1>
          <p className="text-muted mt-1 text-sm">Create your account.</p>
        </div>
        <SignUp
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
