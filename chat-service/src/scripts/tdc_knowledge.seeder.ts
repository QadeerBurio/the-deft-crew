/**
 * TDC Knowledge Seeder
 * Seeds static company knowledge, founder profile, and university partnerships
 * into the KnowledgeDocument collection under category 'tdc_knowledge'.
 *
 * Run with: node -r ts-node/register src/scripts/tdc_knowledge.seeder.ts
 * Or after build: node chat-service/dist/scripts/tdc_knowledge.seeder.js
 */

import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../../../.env') });

const MONGO_URI = process.env.BACKEND_MONGO_URI || process.env.MONGO_URI || '';

// Minimal schema inline for the seeder (mirrors KnowledgeDocument)
const KnowledgeDocumentSchema = new mongoose.Schema({
  title: String,
  content: String,
  category: String,
  status: { type: String, default: 'published' },
  metadata: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const TDC_KNOWLEDGE_DOCUMENTS = [
  {
    title: 'About The Deft Crew (TDC)',
    category: 'tdc_knowledge',
    status: 'published',
    content: `The Deft Crew (TDC) is a premium, AI-powered student platform that bridges the gap between academia and industry. TDC connects students, brands, universities, and employers in a single unified ecosystem.

Mission: To empower students with real-world opportunities, career resources, and industry connections — powered by AI.
Vision: To become Pakistan's #1 student-focused technology ecosystem.

TDC serves students, brand partners, university partners, employers, travelers, and the wider TDC community.`,
    metadata: { source: 'tdc_company', tags: ['about', 'overview', 'tdc', 'deft crew', 'mission', 'vision'] },
  },
  {
    title: 'TDC Digital Marketing & Branding Services',
    category: 'tdc_knowledge',
    status: 'published',
    content: `TDC offers a comprehensive suite of digital marketing and branding services:

- Performance Marketing: Google Ads, Meta Ads, TikTok Ads, LinkedIn Ads campaigns
- SEO (Search Engine Optimization) & Content Strategy
- Social Media Marketing & Management
- Graphic Design & Visual Branding
- Email Marketing & CRM
- Influencer Marketing

TDC's marketing team has experience scaling brands across Pakistan and internationally.`,
    metadata: { source: 'tdc_services', tags: ['digital marketing', 'performance marketing', 'seo', 'google ads', 'meta ads', 'social media', 'branding'] },
  },
  {
    title: 'TDC Technology Solutions & AI Services',
    category: 'tdc_knowledge',
    status: 'published',
    content: `TDC builds technology solutions for businesses of all sizes:

- Website Development: Corporate websites, E-commerce platforms, Landing Pages
- Mobile App Development: iOS and Android apps
- Custom Software Development
- AI Dashboards & Analytics
- Workflow Automation & Business Process Automation
- AI Solutions & AI Strategy Consulting
- Digital Transformation Consulting

TDC specializes in deploying practical AI tools that create measurable business impact.`,
    metadata: { source: 'tdc_services', tags: ['technology', 'web development', 'app development', 'ai', 'automation', 'software', 'consulting'] },
  },
  {
    title: 'TDC Student Ecosystem & Platform Features',
    category: 'tdc_knowledge',
    status: 'published',
    content: `The TDC student platform is Pakistan's most comprehensive student career and lifestyle portal:

- Internship Portal: Connect with top employers for paid and unpaid internships
- Brand Discounts: Exclusive student deals at restaurants, fashion brands, cafes, and electronics stores
- Scholarships: Discover and apply for fully-funded, merit-based, and need-based scholarships
- Campus Events: Meetups, hackathons, networking mixers, coding competitions, seminars
- Travel Packages: Student-friendly group tours and adventure packages
- CV & Resume Builder: AI-powered resume builder with ATS optimization and professional templates
- Career Coaching: Personalized career guidance based on your academic and professional profile`,
    metadata: { source: 'tdc_platform', tags: ['student', 'internship', 'discounts', 'scholarship', 'events', 'travel', 'resume', 'career'] },
  },
  {
    title: 'Majid Shah — Founder & Head of Marketing at TDC',
    category: 'tdc_knowledge',
    status: 'published',
    content: `Full Name: Majid Shah
Current Role: Founder, Growth Partner, Head of Marketing & Co-founder at The Deft Crew (TDC)

Professional Summary:
Majid Shah is a growth strategist, AI adoption consultant, digital marketing expert, workflow automation specialist, and business growth consultant with a proven track record of scaling companies across multiple industries.

Core Expertise:
Growth Marketing, Performance Marketing, AI Automation, Digital Transformation, Google Ads, Meta Ads, LinkedIn Marketing, TikTok Marketing, SEO, Content Strategy, CRM, Analytics, Business Growth, Marketing Strategy

Professional Journey:
1. Ftech Solutions — Early career foundation
2. Medical Lien Management — Professional development
3. Sybrid — Started as Assistant Team Lead, progressed to Team Lead
4. Smartchoice.pk — Customer Success Advisor → Team Lead → Team Lead Growth (Worked directly with the CEO and founding team to scale the company)
5. PayActiv — Growth Marketer (Enterprise growth campaigns and strategic marketing initiatives)
6. GiftKarte — Head of Marketing & Consumer Experience (Led marketing operations, customer acquisition, email marketing, influencer marketing, SEO, PPC, UX optimization, and multidisciplinary team management — contributed to significant business growth)
7. The Deft Crew — Head of Marketing & Co-founder (Current: growth strategy, AI adoption, digital transformation, technology solutions, university partnerships, ecosystem development, business automation, student initiatives)`,
    metadata: { source: 'tdc_founder', tags: ['majid shah', 'founder', 'co-founder', 'head of marketing', 'growth strategist', 'ai consultant', 'leadership'] },
  },
  {
    title: 'TDC University Partnerships Program',
    category: 'tdc_knowledge',
    status: 'published',
    content: `TDC partners with leading universities across Pakistan to bridge academia and industry:

Partner Universities:
- IoBM (Institute of Business Management)
- SZABIST (Shaheed Zulfikar Ali Bhutto Institute of Science and Technology)
- Ziauddin University
- Indus University
- Denning
- And other partner institutions

Purpose and Benefits:
These collaborations aim to bridge academia and industry through:
- Internship placements for students at top companies
- Practical learning through real-world projects
- Employer engagement and industry networking
- Brand collaborations and student discount programs
- Career development workshops and mentorship
- AI education and digital literacy programs
- University-to-industry talent pipeline creation

Students from partner universities get priority access to exclusive TDC opportunities.`,
    metadata: { source: 'tdc_universities', tags: ['university', 'partnership', 'iobm', 'szabist', 'ziauddin', 'indus', 'academia', 'industry', 'internship'] },
  },
];

async function seedTDCKnowledge() {
  if (!MONGO_URI) {
    console.error('❌ Error: MONGO_URI or BACKEND_MONGO_URI is not set in environment variables.');
    process.exit(1);
  }

  console.log('🔗 Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB');

  const KnowledgeDocument = mongoose.model('KnowledgeDocument', KnowledgeDocumentSchema);

  // Remove existing tdc_knowledge documents to prevent duplicates
  const deleted = await KnowledgeDocument.deleteMany({ category: 'tdc_knowledge' });
  console.log(`🗑️  Removed ${deleted.deletedCount} existing tdc_knowledge documents`);

  // Insert fresh documents
  const inserted = await KnowledgeDocument.insertMany(TDC_KNOWLEDGE_DOCUMENTS);
  console.log(`✅ Successfully seeded ${inserted.length} TDC knowledge documents:`);
  inserted.forEach((doc: any) => console.log(`   📄 ${doc.title}`));

  await mongoose.disconnect();
  console.log('🔗 Disconnected from MongoDB');
  console.log('\n✅ TDC Knowledge seeding complete! Run a sync to generate embeddings.');
}

seedTDCKnowledge().catch((err) => {
  console.error('❌ Seeder failed:', err.message);
  process.exit(1);
});
