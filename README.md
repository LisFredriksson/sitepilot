# SitePilot

## Läsning av Gutenberg-paragrafer

Välj en sida och hämta dess titel. Under titelverktyget hämtas och visas nu
sidans `core/paragraph`-block och `<p>`-stycken i blockens egen HTML som vanlig,
skrivskyddad text, även inuti grupper och kolumner. Tomma stycken visas som
`(Tomt stycke)`. Visningen skiljer mellan `Paragrafblock` och `HTML-stycke`.

- `src/lib/wordpress.ts`: autentiserad hämtning av `content.raw` med `context=edit`.
- `src/lib/gutenberg.ts`: blockmodell, SHA-256 av exakt original, parsning och textutvinning.
- `src/app/api/wordpress/page/content/route.ts`: lokal GET-endpoint; returnerar endast sid-ID, hash och paragraftexter med blocksökvägar.
- `src/components/wordpress_paragraphs.tsx`: textvisning, fel och avbrutna anrop vid sidbyte.

Originalets HTML och alla parsade blocktyper behålls i serverns läsmodell.
Modellen är inte avsedd att serialiseras tillbaka för sparande. En blocksökväg
gäller bara för originalversionen med samma hash och är inget permanent ID.
`inner_content` behåller HTML-fragmentens ordning med null-markörer för underblock.
HTML-stycken identifieras av ägarblockets sökväg och ett nollbaserat
`html_paragraph_index`, tillsammans med innehållshashen. Det är en läsreferens,
inte en instruktion att skriva till WordPress. HTML-stycken som korsar en
underblocksgräns avvisas eftersom deras referens inte är entydig.
Refererade mönster och temamallars innehåll följs inte. HTML visas aldrig direkt.
Läsningen har gränser på 512 KiB originalinnehåll, 2 000 block och 30 blocknivåer.
WordPress JSON-svaret begränsas till 4 MiB före tolkning.

Testfilerna ligger samlade i `tests/`, med filnamn som visar vilken modul de testar.
Kör `npm test` med Node.js 24 för parserns tester (inga nätverksanrop).
`npm run lint` och `npx tsc --noEmit` kontrollerar övrig kod.
Prova i webbläsaren med flera stycken, ett tomt stycke, rubriker, länkar,
fetstil och ett stycke inuti en grupp. Byt sedan sida under hämtningen:
föregående sidas innehåll ska försvinna. Funktionen gör inga innehållsuppdateringar
och använder inte AI.

## AI-förslag för brödtext

Under textstyckena finns ett separat instruktionsfält och `Föreslå brödtext med AI`.
Knappen anropar `/api/ai/text` och kan medföra en OpenAI-kostnad. Gränssnittet
visar original och förslag, eller en följdfråga. För paragrafblock finns
`Godkänn och spara`; HTML-stycken kan bara förhandsvisas.
Förslaget innehåller sid-ID, originalets hash och målstyckets fullständiga
läsreferens, inklusive källtyp och HTML-styckeindex när det behövs.

`src/lib/text_proposal.ts` validerar att svaret gäller rätt sida, innehållsversion
och originalstycke. `src/components/wordpress_text_proposal.tsx` anropar endpointen
och visar svaret. Ändrad instruktion rensar förslaget; följdfrågan behålls medan
användaren skriver en fullständig, förtydligad instruktion. Ingen chatthistorik skickas.
Sidbyte eller ny innehållsversion rensar utkastet och avbryter pågående anrop.
Vid innehållskonflikt måste sidan hämtas igen innan ett nytt försök.
Endast uttryckligt godkännande anropar WordPress-endpointen för sparande.
Efter bekräftat sparande hämtas innehållet igen. Alla misslyckade sparförsök
spärrar fortsatta försök tills användaren hämtat aktuellt innehåll.

## AI-endpoint för brödtext

`POST /api/ai/text` tar emot `page_id`, `content_hash` och `instruction`.
Den hämtar originalet med den anslutna WordPress-användarens behörighet och
avvisar ändrad hash före AI-anropet. Högst 100 icke-tomma textstycken och
32 KiB JSON-kandidatdata tillåts; större sidor avvisas utan trunkering.
Request-body begränsas till 16 KiB och instruktionen till 1 000 tecken.

`suggest_text_change()` i `src/lib/ai.ts` använder Responses API med strikt
JSON-schema, utan verktyg eller automatiska återförsök. Modellen väljer ett
kandidat-ID eller ställer en följdfråga. Servern validerar svaret och hämtar
blockreferensen ur originalet. Förslag är högst 5 000 tecken, följdfrågor 500.
Modellen ser vanlig stycketext, inte HTML, rubriker eller sidlayout.

Endpointen har ingen skrivfunktion.
Tester i `tests/ai_text_route.test.mts` ersätter WordPress- och AI-anrop med
simulerade svar; `npm test` medför inga externa anrop eller kostnader.
`tests/text_proposal_ui.test.mts` testar komponentens anrop, följdfrågor,
konflikter och avbrutna anrop med simulerade React-hooks och fetch.
De testerna kontrollerar inte webbläsarens layout eller DOM.

## Next.js-startprojekt

### Förberedd endpoint för paragrafgodkännande

`POST /api/wordpress/page/paragraph` tar emot `page_id`, `content_hash`,
`target`, `proposed_text` och `approved: true`. Den är enbart tillgänglig i
utvecklingsläge med projektets lokala Host/Origin-kontroller. Dessa ersätter
inte autentisering vid en framtida publik driftsättning.

Servern hämtar originalet med `context=edit`, kontrollerar hash och målstycke,
bygger ett begränsat textbyte och skickar innehållet till WordPress. Endast
entydiga `core/paragraph` med vanlig text stöds. AI anropas inte vid sparande.
Flaggan `approved` är klientens uttryckliga begäran, inte ett serverlagrat
bevis på att ett visst AI-förslag har godkänts.

Ändrat original ger `409 CONTENT_CHANGED`. Osäker skrivning ger
`502 SAVE_UNCONFIRMED` utan automatiskt återförsök. Gränssnittet kräver
omläsning efter osäkert sparande och spärrar dubbelklick medan anropet pågår.
Hashkontrollen är inte en atomisk WordPress-låsning: samtidig redigering
mellan läsning och skrivning kan fortfarande inträffa.

`tests/paragraph_route.test.mts` testar med simulerad WordPress-koppling.

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
