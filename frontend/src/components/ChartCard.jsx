import SectionCard from "./SectionCard";

export default function ChartCard({ title, subtitle, children }) {
  return (
    <SectionCard title={title} subtitle={subtitle}>
      {children}
    </SectionCard>
  );
}
