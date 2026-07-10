/**
 * TDC Knowledge Seeder — Plain Node.js (no TypeScript compilation needed)
 * Run: node scripts/seed_tdc_knowledge.js
 */

'use strict';

const mongoose = require('mongoose');
const path = require('path');

// Load .env from root Backend directory
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const MONGO_URI = process.env.BACKEND_MONGO_URI || process.env.MONGO_URI || '';

if (!MONGO_URI) {
  console.error('❌ Error: BACKEND_MONGO_URI or MONGO_URI is not set.');
  process.exit(1);
}

const KnowledgeDocumentSchema = new mongoose.Schema({
  title: String,
  content: String,
  category: String,
  status: { type: String, default: 'published' },
  metadata: mongoose.Schema.Types.Mixed,
  source: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true, collection: 'knowledgedocuments' });

const TDC_DOCUMENTS = [
  {
    title: 'About The Deft Crew (TDC) — Overview',
    category: 'tdc_knowledge',
    status: 'published',
    content: `The Deft Crew (TDC) is a premium, AI-powered student platform that bridges the gap between academia and industry. TDC connects students, brands, universities, and employers in a single unified ecosystem.

Mission: To empower students with real-world opportunities, career resources, and industry connections — powered by AI.
Vision: To become Pakistan's #1 student-focused technology ecosystem.

TDC serves students, brand partners, university partners, employers, travelers, and the wider TDC community.

TDC is based in Pakistan and operates as a digital-first company offering both B2B technology and marketing services as well as a B2C student portal.`,
    metadata: { source: 'tdc_company', tags: ['about', 'overview', 'tdc', 'deft crew', 'mission', 'vision', 'pakistan'] },
  },
  {
    title: 'TDC Digital Marketing & Branding Services',
    category: 'tdc_knowledge',
    status: 'published',
    content: `TDC offers a comprehensive suite of digital marketing and branding services for businesses:

Performance Marketing:
- Google Ads (Search, Display, Shopping, YouTube)
- Meta Ads (Facebook & Instagram)
- TikTok Ads
- LinkedIn Ads for B2B

Organic Marketing:
- SEO (Search Engine Optimization) & Content Strategy
- Social Media Marketing & Management
- Content Creation & Copywriting

Brand Building:
- Graphic Design & Visual Identity
- Brand Strategy & Positioning
- Email Marketing & CRM Automation
- Influencer Marketing & Partnerships

TDC's marketing team has a proven track record of scaling brands with measurable ROI.`,
    metadata: { source: 'tdc_services', tags: ['digital marketing', 'performance marketing', 'seo', 'google ads', 'meta ads', 'social media', 'branding', 'tiktok', 'linkedin'] },
  },
  {
    title: 'TDC Technology Solutions — Web, App, AI & Automation',
    category: 'tdc_knowledge',
    status: 'published',
    content: `TDC builds technology solutions for businesses of all sizes:

Website Development:
- Corporate websites and company portals
- E-commerce platforms and online stores
- High-conversion landing pages

Mobile App Development:
- iOS and Android native apps
- Cross-platform applications

Custom Software:
- Custom Software Development (ERP, CRM, inventory systems)
- AI Dashboards & Business Intelligence
- Data Analytics & Reporting

AI & Automation:
- Workflow Automation & Business Process Automation
- AI-powered Chatbots and Virtual Assistants
- AI Strategy Consulting for SMEs and enterprises
- Digital Transformation end-to-end consulting

TDC specializes in deploying practical AI tools that create measurable business impact without requiring large teams.`,
    metadata: { source: 'tdc_services', tags: ['technology', 'web development', 'app development', 'ai', 'automation', 'software', 'consulting', 'chatbot', 'erp'] },
  },
  {
    title: 'TDC Student Ecosystem — Platform Features',
    category: 'tdc_knowledge',
    status: 'published',
    content: `The TDC app is Pakistan's most comprehensive student career and lifestyle portal:

Career Development:
- Internship Portal: Paid and unpaid internship listings from top employers
- Job Board: Full-time, part-time, and remote job listings
- Career Coaching: AI-powered personalized career guidance

Financial Aid:
- Scholarships: Fully-funded, merit-based, and need-based opportunities
- Financial Aid Discovery from international and national programs

Lifestyle:
- Brand Discounts: Exclusive student deals at 200+ restaurants, fashion brands, cafes, and electronics stores
- Campus Events: Meetups, hackathons, networking mixers, coding competitions, seminars

Learning:
- Notes & Study Material
- Lecture Recordings
- Past Papers Archive
- Books Database

Professional Tools:
- CV & Resume Builder: AI-powered builder with ATS optimization and 10+ professional templates
- Portfolio Builder

Travel:
- Student-friendly group tours and adventure travel packages`,
    metadata: { source: 'tdc_platform', tags: ['student', 'internship', 'discounts', 'scholarship', 'events', 'travel', 'resume', 'career', 'jobs', 'platform', 'app'] },
  },
  {
    title: 'Majid Shah — Founder & Co-founder of The Deft Crew',
    category: 'tdc_knowledge',
    status: 'published',
    content: `Full Name: Majid Shah
Current Role: Founder, Growth Partner, Head of Marketing & Co-founder at The Deft Crew (TDC)

Professional Summary:
Majid Shah is a growth strategist, AI adoption consultant, digital marketing expert, workflow automation specialist, and business growth consultant with a proven track record of scaling companies across multiple industries in Pakistan and internationally.

Core Expertise:
Growth Marketing, Performance Marketing, AI Automation, Digital Transformation, Google Ads, Meta Ads, LinkedIn Marketing, TikTok Marketing, SEO, Content Strategy, CRM, Analytics, Business Growth, Marketing Strategy, Team Leadership

Professional Journey:
1. Ftech Solutions — Early career foundation in professional environment
2. Medical Lien Management — Expanded professional scope
3. Sybrid — Grew from Assistant Team Lead to full Team Lead
4. Smartchoice.pk — Progressed from Customer Success Advisor to Team Lead Growth, working directly with the CEO and founding team to scale the company
5. PayActiv — Growth Marketer running enterprise growth campaigns and strategic marketing initiatives
6. GiftKarte — Head of Marketing & Consumer Experience: Led all marketing operations including customer acquisition, email marketing, influencer campaigns, SEO, PPC, UX optimization, consumer experience, and multidisciplinary team management
7. The Deft Crew — Head of Marketing & Co-founder (current): Responsible for growth strategy, AI adoption consulting, digital transformation, university partnerships, student ecosystem development, business automation, and student community initiatives

Leadership Philosophy:
Majid believes in practical AI adoption, data-driven growth marketing, and building systems that scale without proportionally scaling costs. His vision for TDC is to empower every Pakistani student with industry-grade opportunities.`,
    metadata: { source: 'tdc_founder', tags: ['majid shah', 'founder', 'co-founder', 'head of marketing', 'growth strategist', 'ai consultant', 'leadership', 'giftKarte', 'payactiv', 'smartchoice'] },
  },
  {
    title: 'TDC University Partnerships & Academic Collaborations',
    category: 'tdc_knowledge',
    status: 'published',
    content: `TDC has established formal partnerships with leading universities across Pakistan:

Current Partner Universities:
- IoBM (Institute of Business Management) — Karachi
- SZABIST (Shaheed Zulfikar Ali Bhutto Institute of Science and Technology) — Multiple campuses
- Ziauddin University — Karachi
- Indus University — Karachi
- Denning — Partner institution
- Additional partner institutions being added

Partnership Benefits for Students:
- Priority access to TDC internship listings
- Campus recruitment drives organized by TDC
- Exclusive brand discount programs for enrolled students
- Access to campus events co-organized with TDC
- AI workshops, digital marketing bootcamps, and career fairs
- University-specific scholarship listings

Partnership Benefits for Universities:
- Industry connection pipeline for students
- Corporate recruitment partners
- AI and technology workshops for faculty and students
- Real-world project collaborations

Partnership Purpose:
TDC's university partnerships aim to bridge the gap between academic learning and industry requirements. Students gain practical exposure, employer connections, and career resources. Universities gain a technology-powered ecosystem that prepares graduates for the modern job market.`,
    metadata: { source: 'tdc_universities', tags: ['university', 'partnership', 'iobm', 'szabist', 'ziauddin', 'indus', 'denning', 'academia', 'industry', 'internship', 'campus', 'karachi'] },
  },
];

async function seed() {
  console.log('\n🚀 TDC Knowledge Seeder Starting...');
  console.log(`🔗 Connecting to: ${MONGO_URI.substring(0, 40)}...`);

  await mongoose.connect(MONGO_URI, {
    dbName: 'The_deft_crew_Ai_assistant',
  });
  console.log('✅ Connected to MongoDB (chat_service database)');

  const KnowledgeDocument = mongoose.model('KnowledgeDocument', KnowledgeDocumentSchema);

  // Wipe existing tdc_knowledge docs to prevent duplicates
  const deleted = await KnowledgeDocument.deleteMany({ category: 'tdc_knowledge' });
  console.log(`🗑️  Removed ${deleted.deletedCount} existing tdc_knowledge documents`);

  // Insert new documents
  const result = await KnowledgeDocument.insertMany(TDC_DOCUMENTS);
  console.log(`\n✅ Successfully inserted ${result.length} TDC knowledge documents:`);
  result.forEach(doc => console.log(`   📄 [${doc._id}] ${doc.title}`));

  await mongoose.disconnect();
  console.log('\n✅ Seeding complete. Database disconnected.');
  console.log('💡 Next step: Trigger a sync at POST /api/v1/sync/trigger?type=incremental to generate embeddings for these documents.\n');
}

seed().catch(err => {
  console.error('\n❌ Seeder failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
