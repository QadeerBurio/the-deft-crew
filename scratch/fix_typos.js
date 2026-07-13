const fs = require('fs');
const path = require('path');

const filepath = path.join(__dirname, '../../Frontend/app/src/services/templateService.js');
let content = fs.readFileSync(filepath, 'utf8');

// Fix FAANG body styles
content = content.replace('background: \\address: \\${bg}', 'background: \\${bg}');
content = content.replace('background: \\address: ${bg}', 'background: ${bg}');

// Fix FAANG edu field of study typo
content = content.replace('\\${edu.degree} \\text: \\${edu.fieldOfStudy || \'\'}', '\\${edu.degree} in \\${edu.fieldOfStudy || \'\'}');
content = content.replace('${edu.degree} \\text: ${edu.fieldOfStudy || \'\'}', '${edu.degree} in ${edu.fieldOfStudy || \'\'}');

// Fix Jakes contact line typo
content = content.replace('\\text: \\${personalInfo?.phone || \'\'}', '\\${personalInfo?.phone || \'\'}');
content = content.replace('\\text: ${personalInfo?.phone || \'\'}', '${personalInfo?.phone || \'\'}');

// Fix Rezi date range typo
content = content.replace('\\text: \\${formatDateRange(w.startDate, w.endDate, w.current)}', '\\${formatDateRange(w.startDate, w.endDate, w.current)}');
content = content.replace('\\text: ${formatDateRange(w.startDate, w.endDate, w.current)}', '${formatDateRange(w.startDate, w.endDate, w.current)}');

// Fix Rezi languages typo
content = content.replace('(\\text: \\${l.proficiency || \'Intermediate\'})', '(\\${l.proficiency || \'Intermediate\'})');
content = content.replace('(\\text: ${l.proficiency || \'Intermediate\'})', '(${l.proficiency || \'Intermediate\'})');

// Fix Canva color/text typo
content = content.replace('color: \\text: \\${text}', 'color: \\${text}');
content = content.replace('color: \\text: ${text}', 'color: ${text}');

fs.writeFileSync(filepath, content, 'utf8');
console.log('Successfully fixed all template typos!');
