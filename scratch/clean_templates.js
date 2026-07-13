const fs = require('fs');
const path = require('path');

const filepath = path.join(__dirname, '../../Frontend/app/src/services/templateService.js');
let content = fs.readFileSync(filepath, 'utf8');

// We want to delete:
// const renderModernTemplate = (resume) => { ... to the line before const renderModernATSTemplate = (resume, styles = {}) => {
const startKeyword = 'const renderModernTemplate = (resume) => {';
const endKeyword = 'const renderModernATSTemplate = (resume, styles = {}) => {';

const startIndex = content.indexOf(startKeyword);
const endIndex = content.indexOf(endKeyword);

if (startIndex === -1 || endIndex === -1) {
  console.error('Could not find keywords!', { startIndex, endIndex });
  process.exit(1);
}

const beforeBlock = content.substring(0, startIndex);
const afterBlock = content.substring(endIndex);

const newContent = beforeBlock + afterBlock;
fs.writeFileSync(filepath, newContent, 'utf8');
console.log('Successfully cleaned up old template renderers!');
