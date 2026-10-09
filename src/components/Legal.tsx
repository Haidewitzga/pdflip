import { imprint, testedWith } from '../site.config'

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
      </ul>
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
        portability, and the right to lodge a complaint with a supervisory authority. Contact details are in the{' '}
        <a href="#imprint">imprint</a>.
      </p>

      <h1 lang="de">Datenschutz</h1>
      <p lang="de">
        <strong>Deine Dateien verlassen dein Gerät nicht.</strong> PDFlip verarbeitet PDFs und Goodnotes-Dateien
        ausschließlich lokal in deinem Browser. Es werden keine Dateien hochgeladen oder gespeichert. Keine Cookies, kein
        Tracking, keine Werbung. Die Website wird über GitHub Pages (GitHub Inc., USA) bereitgestellt; dabei verarbeitet
        GitHub technisch notwendige Daten wie deine IP-Adresse in Server-Logs (Art. 6 Abs. 1 lit. f DSGVO).
      </p>
    </section>
  )
}

export function Imprint() {
  const filled = imprint.name && imprint.street && imprint.city && imprint.email
  return (
    <section className="legal">
      <h1>Imprint / Impressum</h1>
      {filled ? (
        <address>
          {imprint.name}
          <br />
          {imprint.street}
          <br />
          {imprint.city}
          {imprint.country && (
            <>
              <br />
              {imprint.country}
            </>
          )}
          <br />
          E-Mail: <a href={`mailto:${imprint.email}`}>{imprint.email}</a>
        </address>
      ) : (
        <p className="muted">Contact details will be added here.</p>
      )}
      <h2>About this project</h2>
      <p>
        PDFlip is a free, non-commercial, open-source tool. It is not affiliated with, endorsed by, or connected to
        Goodnotes. Goodnotes is a trademark of its respective owner and is mentioned only to describe file compatibility.
      </p>
      <p>
        The Goodnotes file format is not publicly documented; PDFlip's support is based on analysing exported files and
        has been tested with {testedWith}. Other versions may not work. Use at your own risk and keep backups of your
        original decks.
      </p>
    </section>
  )
}
