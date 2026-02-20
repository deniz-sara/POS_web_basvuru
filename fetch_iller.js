const https = require('https');
const fs = require('fs');
const path = require('path');

https.get('https://turkiyeapi.dev/api/v1/provinces', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const json = JSON.parse(data);
        const iller = {};
        json.data.forEach(p => {
            const districts = p.districts.map(d => d.name);
            districts.sort((a,b)=>a.localeCompare(b, 'tr'));
            iller[p.name] = districts;
        });
        
        // Sort keys
        const sortedIller = Object.keys(iller).sort((a,b)=>a.localeCompare(b, 'tr')).reduce(
            (obj, key) => { 
                obj[key] = iller[key]; 
                return obj;
            }, 
            {}
        );

        fs.writeFileSync(path.join(__dirname, 'public/js/iller.js'), 'const TURKIYE_IL_ILCE = ' + JSON.stringify(sortedIller, null, 2) + ';');
        console.log('Successfully saved to public/js/iller.js');
    });
});
