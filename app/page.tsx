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
          <p className="eyebrow"><span /> בערך 20 פניות שלא נסגרות בחודש?</p>
          <h1>Shuv Flow אומר<br />למי לחזור. ולמה עכשיו.</h1>
          <p className="hero__lead">מעלים את הפניות שכבר שילמתם עליהן. המערכת מסדרת למה הן נעצרו, מזהה מתי נוצרה סיבה אמיתית לחזור, ומכינה לצוות את ההודעה — לא עוד פולואפ כללי של “עדיין רלוונטי?”.</p>
          <div className="hero__actions" aria-label="פתיחת סביבת ניסיון">
            <Link href="/signup/" className="button button--hero">לבדוק על 20 פניות</Link>
            <span>פיילוט 14 יום · שום הודעה לא נשלחת לבד</span>
          </div>
        </div>

        <div className="product-glimpse" aria-label="תצוגה מקדימה של מסך היום">
          <div className="product-glimpse__bar">
            <Image className="glimpse-logo" src="/shuv-flow-logo.png" alt="Shuv Flow" width={1200} height={400} priority />
            <span>היום, במרפאה</span>
            <span className="live-dot">מחובר</span>
          </div>
          <div className="product-glimpse__body">
            <p className="glimpse-date">אחרי שבדקנו 20 פניות</p>
            <h2>מה כדאי לעשות עכשיו?</h2>
            <div className="glimpse-focus">
              <span className="focus-number">3</span>
              <div>
                <strong>פניות ששווה לבדוק היום</strong>
                <p>בכל אחת יש קשר ברור בין מה שעצר אותה לבין מה שהשתנה עכשיו.</p>
              </div>
            </div>
            <Link href="/signup/" className="glimpse-button">לראות למה דווקא הן</Link>
            <div className="glimpse-rule"><span>✓</span><p><strong>אין סיבה. אין הודעה.</strong><br />אם אין סיבה אמיתית — Shuv Flow אומר לא לפנות.</p></div>
          </div>
        </div>
      </section>

      <section className="principles" aria-label="איך זה עובד">
        <article><span>01</span><h2>מעלים את האבודות</h2><p>שם, קשר, שירות והערה מהשיחה. גם CSV פשוט מספיק.</p></article>
        <article><span>02</span><h2>Shuv Flow מסדר מה קרה</h2><p>למה נעצרו, איפה חסר מידע ומי בכלל יכולה להיות רלוונטית לחזרה.</p></article>
        <article><span>03</span><h2>פונים רק כשיש למה</h2><p>התפנה תור? חזר שירות? הגיע מועד? רואים למי זה מתאים ומה כדאי לכתוב.</p></article>
      </section>

      <section className="quiet-proof">
        <div>
          <p className="eyebrow"><span /> לא CRM. לא עוד מערכת לנהל.</p>
          <h2>פותחים ומקבלים תשובה אחת.</h2>
        </div>
        <p><strong>מה שווה לעשות עכשיו?</strong> אם יש פנייה שכדאי לבדוק — תראו אותה ואת הסיבה. אם אין — המערכת תגיד שאין סיבה טובה לפנות. הצוות רק מאשר, שולח ומתעד מה קרה.</p>
      </section>

      <footer className="landing-footer">
        <Logo compact />
        <p>מחזירים פניות לשיחה רק כשיש סיבה טובה.</p>
        <Link href="/signup/" className="button">לבדוק על 20 פניות</Link>
      </footer>
    </main>
  );
}
