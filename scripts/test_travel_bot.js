const OpenAI = require('openai');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { TRAVEL_SYSTEM_PROMPT } = require('../chat-service/dist/prompts/travel.prompt');

async function testQuery(query) {
  console.log(`\n💬 Testing User Query: "${query}"`);
  
  if (!process.env.OPENAI_API_KEY) {
    console.log('❌ Error: OPENAI_API_KEY is not set in environmental configs.');
    return;
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  
  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: TRAVEL_SYSTEM_PROMPT },
        { role: 'user', content: query }
      ],
      temperature: 0.3
    });

    const reply = response.choices[0]?.message?.content || '';
    console.log('🤖 Assistant Reply:\n', reply);
    
    // Check if it triggered the fallback text
    const hasFallbackText = reply.includes("I'm your Travel & Tourism Assistant");
    console.log(`🔍 Fallback Triggered: ${hasFallbackText ? '❌ YES (Incorrect)' : '✅ NO (Correct)'}`);
  } catch (err) {
    console.error('❌ Request failed:', err.message);
  }
}

async function main() {
  // Wait, let's verify if the travel prompt is loaded correctly
  if (!TRAVEL_SYSTEM_PROMPT) {
    console.error('❌ Error: Could not load TRAVEL_SYSTEM_PROMPT. Make sure the chat-service is compiled (run tsc or build if needed).');
    process.exit(1);
  }

  await testQuery('Current airfare for karachi to dubai');
  await testQuery('What resorts are available in dubai');
  await testQuery('Dubai travel guide lines');
}

main();
