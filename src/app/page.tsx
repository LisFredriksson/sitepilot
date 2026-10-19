import WordPressPagePreview from "@/components/wordpress_page_preview";
export default function Home() {
  return (
    <main className="min-h-screen bg-slate-50 p-10">
      <h1 className="text-4xl font-bold text-slate-900">
        SitePilot
      </h1>

      <p className="mt-4 text-lg text-slate-600">
        Din AI-assistent för WordPress.
      </p>

      <div className="mt-10 rounded-xl bg-white p-8 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">
          Välkommen till SitePilot!
        </h2>
        <p className="mt-2 text-slate-600">
          Här kommer du snart kunna hantera din
          WordPress-webbplats med hjälp av AI.
        </p>
      </div>
      <WordPressPagePreview />
    </main>
  );
}
