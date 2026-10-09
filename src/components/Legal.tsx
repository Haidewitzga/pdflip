export function Privacy() {
  return (
    <section className="legal">
      <h1>Privacy</h1>
      <p>
        <strong>Your files never leave your device.</strong> PDFlip converts PDFs and Goodnotes files entirely inside your
        web browser. Nothing you open here is uploaded, stored or seen by anyone else.
      </p>
      <ul>
        <li>No cookies, no analytics, no tracking, no ads.</li>
        <li>No accounts and no server-side processing.</li>
        <li>No external fonts or scripts are loaded from third parties.</li>
        <li>
          So that PDFlip also opens without internet, your browser keeps a copy of the website's own files (about 4 MB).
          It contains none of your files. Deleting the website data in your browser settings removes it.
        </li>
      </ul>
      <h2>Problem reports</h2>
      <p>
        When PDFlip cannot fully read a file, it shows what went wrong and offers a <em>Send report</em> button. Nothing
        is sent unless you tap it, and you can see exactly what will be sent first. A report contains only technical
        details: names of file structures and character sets, a few Unicode code points, error messages, the PDFlip
        version and your browser type (e.g. “Safari 18 on iPad”). It never contains your file, its pictures or the text
        of your cards.
      </p>
      <p>
        Reports go to a small relay service on Cloudflare (Cloudflare, Inc., USA), which turns them into a public issue
        in the PDFlip repository on GitHub so the problem can be fixed. Cloudflare processes your IP address to deliver
        the report and to limit how many reports one device can send; PDFlip does not store it. The legal basis is our
        legitimate interest in fixing errors (Art. 6(1)(f) GDPR).
      </p>
      <h2>Hosting</h2>
      <p>
        This website is hosted on GitHub Pages, provided by GitHub Inc., 88 Colin P. Kelly Jr. Street, San Francisco, CA
        94107, USA. When you visit the site, GitHub processes technical data such as your IP address in server logs to
        deliver the site and keep it secure. See the{' '}
        <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" target="_blank" rel="noreferrer">
          GitHub Privacy Statement
        </a>
        . The legal basis is our legitimate interest in providing a working website (Art. 6(1)(f) GDPR).
      </p>
      <h2>Your rights</h2>
      <p>
        Under the GDPR you have the right to access, rectification, erasure, restriction of processing, objection and data
        portability, and the right to lodge a complaint with a supervisory authority.
      </p>

      <h1 lang="de">Datenschutz</h1>
      <p lang="de">
        <strong>Deine Dateien verlassen dein Gerät nicht.</strong> PDFlip verarbeitet PDFs und Goodnotes-Dateien
        ausschließlich lokal in deinem Browser. Es werden keine Dateien hochgeladen oder gespeichert. Keine Cookies, kein
        Tracking, keine Werbung. Damit PDFlip auch ohne Internet startet, speichert dein Browser eine Kopie der Dateien
        der Website (ca. 4 MB), aber keine deiner Dateien. Die Website wird über GitHub Pages (GitHub Inc., USA) bereitgestellt; dabei verarbeitet
        GitHub technisch notwendige Daten wie deine IP-Adresse in Server-Logs (Art. 6 Abs. 1 lit. f DSGVO).
      </p>
      <p lang="de">
        Fehlerberichte: Kann PDFlip eine Datei nicht vollständig lesen, kannst du mit „Send report“ einen Bericht senden.
        Ohne diesen Tipp wird nichts gesendet, und du siehst vorher genau, was gesendet wird: nur technische Angaben
        (Dateistrukturen, Zeichensätze, Fehlermeldungen, PDFlip-Version, Browsertyp), nie deine Datei oder Kartentexte.
        Der Bericht läuft über einen Dienst von Cloudflare (Cloudflare, Inc., USA), der dabei deine IP-Adresse verarbeitet,
        und wird zu einem öffentlichen Issue auf GitHub (Art. 6 Abs. 1 lit. f DSGVO).
      </p>
    </section>
  )
}
