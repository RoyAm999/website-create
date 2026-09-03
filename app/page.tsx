import Link from "next/link";
import Image from "next/image";
import { Logo } from "@/components/logo";

export default function LandingPage() {
  return (
    <main className="landing">
      <header className="landing-header">
        <Logo />
        <nav aria-label="פעולות חשבון">
          <Link href="/login/" className="text-link">כניסה</Link>
          <Link href="/signup/" className="button button--small">פתיחת פיילוט</Link>
        </nav>
      </header>

      <section className="hero">
        <div className="hero__copy">
          <p className="eyebrow"><span /> פניות שכבר שילמתם עליהן</p>
          <h1>לדעת למי באמת<br />שווה לחזור היום.</h1>
          <p className="hero__lead">Shuv Flow בודק למה כל פנייה נעצרה, מה השתנה מאז, ומראה לצוות רק את הפניות שיש סיבה אמיתית לחזור אליהן.</p>
          <div className="hero__actions" aria-label="פתיחת סביבת ניסיון">
            <Link href="/signup/" className="button button--hero">פתיחת סביבת ניסיון</Link>
            <span>14 יום · בלי הודעות אוטומטיות</span>
          </div>
        </div>

        <div className="product-glimpse" aria-label="תצוגה מקדימה של מסך היום">
          <div className="product-glimpse__bar">
            <Image className="glimpse-logo" src="/shuv-flow-logo.png" alt="Shuv Flow" width={1200} height={400} />
            <span>היום, במרפאה</span>
            <span className="live-dot">מחובר</span>
          </div>
          <div className="product-glimpse__body">
            <p className="glimpse-date">יום חמישי · 3 בספטמבר</p>
            <h2>מה כדאי לעשות עכשיו?</h2>
            <div className="glimpse-focus">
              <span className="focus-number">3</span>
              <div>
                <strong>פניות ששווה לבדוק היום</strong>
                <p>לכל אחת נמצאה סיבה ברורה ורלוונטית.</p>
              </div>
            </div>
            <Link href="/signup/" className="glimpse-button">לראות את ה־3</Link>
            <div className="glimpse-rule"><span>✓</span><p><strong>אין סיבה. אין הודעה.</strong><br />לא פונים רק כי עבר זמן.</p></div>
          </div>
        </div>
      </section>

      <section className="principles" aria-label="איך זה עובד">
        <article><span>01</span><h2>מעלים פניות</h2><p>שם, פרטי קשר, שירות והסיבה שבגללה נעצרו.</p></article>
        <article><span>02</span><h2>מספרים מה השתנה</h2><p>תור שהתפנה, שירות שחזר או מועד שהגיע.</p></article>
        <article><span>03</span><h2>פונים רק כשיש למה</h2><p>הצוות רואה אז, עכשיו ולמה — ומאשר ידנית.</p></article>
      </section>

      <section className="quiet-proof">
        <div>
          <p className="eyebrow"><span /> המוצר חושב. הצוות מחליט.</p>
          <h2>לא עוד מערכת שצריך לנהל.</h2>
        </div>
        <p>פותחים את Shuv Flow ומקבלים תשובה אחת: מה כדאי לעשות עכשיו. בלי טבלאות CRM, בלי ציונים סודיים ובלי לשלוח הודעה אחת שאין לה סיבה טובה.</p>
      </section>

      <footer className="landing-footer">
        <Logo compact />
        <p>פניות חוזרות. צמיחה אמיתית.</p>
        <Link href="/signup/" className="button">התחלה</Link>
      </footer>
    </main>
  );
}
