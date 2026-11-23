// Egyptian Arabic message templates for the AgriTrade WhatsApp bot

const MENU = `أهلاً بيك في أجري تريد 🌾
خدمة أسعار وأخبار سوق الحبوب في مصر.

اختار رقم:
1️⃣ موجز النهاردة
2️⃣ الأسعار
3️⃣ اسأل سؤال

ولإيقاف الرسايل في أي وقت ابعت: إلغاء`;

const WELCOME_SUBSCRIBED = `تمام يا باشا ✅ اشتراكك اتفعل.
هيوصلك موجز السوق كل يوم الصبح، وتقدر تسأل عن الأسعار في أي وقت.

${MENU}`;

const ALREADY_SUBSCRIBED = `انت مشترك معانا بالفعل ✅

${MENU}`;

const UNSUBSCRIBED = `تم إيقاف الرسايل. لو حبيت ترجع في أي وقت ابعت: اشتراك`;

const NOT_SUBSCRIBED = `عشان تستفيد من الخدمة لازم تشترك الأول.
ابعت: اشتراك
وهيوصلك موجز السوق اليومي على رقمك.`;

const BRIEF_UNAVAILABLE = `الموجز لسه بيتجهز، جرب تاني بعد شوية 🙏`;

const PRICES_UNAVAILABLE = `الأسعار لسه مش متوصلة، جرب تاني بعد شوية 🙏`;

const ASK_RECEIVED = `سجلت سؤالك ✅ وهرد عليك في أقرب وقت.`;

const ASK_LIMIT_REACHED = `وصلت للحد الأقصى من الأسئلة النهاردة (٢٠ سؤال). جرب بكرة إن شاء الله 🙏`;

const QUESTION_THINKING = `ثانية واحدة بدورلك على الإجابة... ⏳`;

const BROADCAST_DONE = (n) => `تم الإرسال لـ ${n} مشترك ✅`;

const ADMIN_ONLY = `الأمر ده للأدمن بس.`;

const PAIRING_CODE_MSG = (code) => `كود الربط الحالي: ${code}`;

const UNKNOWN = `مش فاهم قصدك 🤔
${MENU}`;

module.exports = {
  MENU,
  WELCOME_SUBSCRIBED,
  ALREADY_SUBSCRIBED,
  UNSUBSCRIBED,
  NOT_SUBSCRIBED,
  BRIEF_UNAVAILABLE,
  PRICES_UNAVAILABLE,
  ASK_RECEIVED,
  ASK_LIMIT_REACHED,
  QUESTION_THINKING,
  BROADCAST_DONE,
  ADMIN_ONLY,
  PAIRING_CODE_MSG,
  UNKNOWN,
};
