import CertTerminalView from "@/components/cert-terminal-view";

export default async function CertPage({ params }: { params: Promise<{ certNumber: string }> }) {
  const { certNumber } = await params;
  return <CertTerminalView initialCert={decodeURIComponent(certNumber)} />;
}
