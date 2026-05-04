import SettingsForm from "./SettingsForm";
import Logo from "@/components/Logo";

export default function SettingsPage() {
  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-3 mb-1">
          <Logo size="sm" showWordmark={false} />
          <h1 className="text-xl font-bold text-white">Kingston&apos;s Settings</h1>
        </div>
        <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
          Kingston&apos;s training plan configuration and performance constants
        </p>
      </div>
      <SettingsForm />
    </div>
  );
}
