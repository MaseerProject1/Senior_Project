export default function DataTable({ columns = [], rows = [], maxRows = 10 }) {
  const sliced = rows.slice(0, maxRows);
  return (
    <div className="overflow-x-auto rounded-lg border border-brand-border">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-brand-bg">
          <tr>
            {columns.map((col) => (
              <th key={col.key} className="px-3 py-2 text-xs uppercase text-brand-muted">
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sliced.map((row, rIdx) => (
            <tr key={rIdx} className="border-t border-brand-border">
              {columns.map((col) => (
                <td key={col.key} className="px-3 py-2">
                  {col.render ? col.render(row[col.key], row) : row[col.key] ?? "N/A"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
