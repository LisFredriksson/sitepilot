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

Kör `npm test` med Node.js 24 för parserns tester (inga nätverksanrop).
`npm run lint` och `npx tsc --noEmit` kontrollerar övrig kod.
Prova i webbläsaren med flera stycken, ett tomt stycke, rubriker, länkar,
fetstil och ett stycke inuti en grupp. Byt sedan sida under hämtningen:
föregående sidas innehåll ska försvinna. Funktionen gör inga innehållsuppdateringar
och använder inte AI.

## Mockat ändringsförslag för brödtext

Under textstyckena finns ett separat instruktionsfält och `Skapa testförslag för
brödtext`. Mocken tolkar inte instruktionen utan använder ett fast exempel för
första icke-tomma stycket. Den visar original och förslag utan någon sparknapp.
Förslaget innehåller sid-ID, originalets hash och målstyckets fullständiga
läsreferens, inklusive källtyp och HTML-styckeindex när det behövs.

`src/lib/text_proposal.ts` skapar mockförslaget utan nätverksanrop eller mutation
av originalet. `src/components/wordpress_text_proposal.tsx` visar det. Ändrad
instruktion rensar förhandsvisningen; sidbyte eller ny hämtning rensar utkastet.
Ingen AI-modell anropas och inget brödtextinnehåll sparas.

## Next.js-startprojekt

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
