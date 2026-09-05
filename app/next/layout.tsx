import type { Metadata } from 'next';
import './next.css';
import './choreography.css';
export const metadata:Metadata={title:'Shuv / כיוון חדש. פנייה שמגיעה מוכנה.',description:'אב־טיפוס לקישור בקשת מחיר מובנית לבעלי מקצוע. בלי הרשמה, בלי ניחושים ובלי הבטחת סגירות.',robots:{index:false,follow:false}};
export default function NextDirectionLayout({children}:{children:React.ReactNode}){return <div className="nx">{children}</div>}
