'use strict';
const fs = require('fs');
let h = fs.readFileSync('index.html', 'utf8');

const OLD_START = 'function exportWord(){';
const OLD_END   = '  catch(e){ abrirNovaAba(); }\r\n}';

const os = h.indexOf(OLD_START);
const oeSearch = h.indexOf(OLD_END, os);
const oe = oeSearch + OLD_END.length;

if (os === -1 || oeSearch === -1) { console.error('not found', os, oeSearch); process.exit(1); }
console.log('found:', os, 'to', oe);

const DOCX_CODE = `function exportWord(){
  const{ok}=podeExportar(); if(!ok) return;
  toast('Gerando DOCX\u2026');
  gerarDocxBlob()
    .then(blob=>{ baixar(blob,nomeArquivo('docx')); toast('DOCX gerado! Abre sem alerta no Word e Google Docs.'); })
    .catch(e=>{ console.error('[docx]',e); abrirNovaAba(); });
}

/* ================= P2.1: gera\u00e7\u00e3o de .docx real (Office Open XML via JSZip) ================= */
function _xmlEsc(s){
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _inlineToRuns(el){
  let r='';
  for(const n of el.childNodes){
    if(n.nodeType===3){const t=n.textContent;if(t)r+=\`<w:r><w:t xml:space="preserve">\${_xmlEsc(t)}</w:t></w:r>\`;}
    else if(n.nodeType===1){
      const tag=n.tagName.toLowerCase();
      if(tag==='b'||tag==='strong'){
        for(const x of n.childNodes)
          if(x.nodeType===3&&x.textContent)
            r+=\`<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">\${_xmlEsc(x.textContent)}</w:t></w:r>\`;
      }else if(tag==='span'&&(n.className==='sign-anchor')){}
      else r+=_inlineToRuns(n);
    }
  }
  return r;
}
function _tableToOoxml(el){
  const rows=el.querySelectorAll('tr');
  const nCols=rows[0]?rows[0].querySelectorAll('td,th').length:1;
  const cw=Math.round(9072/nCols);
  let x=\`<w:tbl><w:tblPr><w:tblW w:w="9072" w:type="dxa"/><w:jc w:val="center"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="808080"/><w:left w:val="single" w:sz="4" w:space="0" w:color="808080"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="808080"/><w:right w:val="single" w:sz="4" w:space="0" w:color="808080"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="808080"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="808080"/></w:tblBorders></w:tblPr><w:tblGrid>\${Array(nCols).fill(\`<w:gridCol w:w="\${cw}"/>\`).join('')}</w:tblGrid>\`;
  for(const row of rows){
    x+='<w:tr>';
    for(const cell of row.querySelectorAll('td,th')){
      const isHdr=cell.tagName==='TH';
      const cls=cell.className||'';
      const jc=cls.includes('n')?'center':cls.includes('v')?'right':'left';
      const span=parseInt(cell.getAttribute('colspan')||'1');
      x+=\`<w:tc><w:tcPr>\${span>1?\`<w:gridSpan w:val="\${span}"/>\`:''}\${isHdr?'<w:shd w:val="clear" w:color="auto" w:fill="EDE4D3"/>':''}</w:tcPr><w:p><w:pPr><w:jc w:val="\${jc}"/></w:pPr><w:r>\${isHdr?'<w:rPr><w:b/><w:sz w:val="17"/></w:rPr>':'<w:rPr><w:sz w:val="18"/></w:rPr>'}<w:t xml:space="preserve">\${_xmlEsc(cell.textContent.trim())}</w:t></w:r></w:p></w:tc>\`;
    }
    x+='</w:tr>';
  }
  return x+'</w:tbl><w:p/>';
}
function _signToOoxml(el){
  const who=el.querySelector('.who'),role=el.querySelector('.role');
  const n=who?_xmlEsc(who.textContent.trim()):'',r=role?_xmlEsc(role.textContent.trim()):'';
  return \`<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="1440" w:after="80"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="000000"/></w:pBdr><w:ind w:left="1440" w:right="1440"/></w:pPr></w:p>\${n?\`<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>\${n}</w:t></w:r></w:p>\`:''}\${r?\`<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="200"/></w:pPr><w:r><w:t>\${r}</w:t></w:r></w:p>\`:''}\`;
}
function _nodeToOoxml(el){
  const tag=el.tagName?.toLowerCase();if(!tag)return'';
  switch(tag){
    case 'h1':return\`<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="200" w:line="360" w:lineRule="auto"/></w:pPr>\${_inlineToRuns(el)}</w:p>\`;
    case 'h2':return\`<w:p><w:pPr><w:spacing w:before="200" w:after="80" w:line="360" w:lineRule="auto"/></w:pPr>\${_inlineToRuns(el)}</w:p>\`;
    case 'p':{
      const cls=el.className||'',sty=el.getAttribute('style')||'';
      const jc=sty.includes('center')?'center':'both';
      const ind=cls.includes('bul')?'<w:ind w:left="360" w:hanging="200"/>':'';
      return\`<w:p><w:pPr><w:jc w:val="\${jc}"/>\${ind}<w:spacing w:line="360" w:lineRule="auto" w:before="0" w:after="160"/></w:pPr>\${_inlineToRuns(el)}</w:p>\`;
    }
    case 'table':return _tableToOoxml(el);
    case 'div':{
      const cls=el.className||'';
      if(cls.includes('sign'))return _signToOoxml(el);
      let o='';for(const c of el.children)o+=_nodeToOoxml(c);return o;
    }
    default:return'';
  }
}
function _domToOoxml(rootEl){
  const clone=rootEl.cloneNode(true);
  clone.querySelectorAll('.lh-header,.lh-footer,.lh-mark,.sign-anchor').forEach(e=>e.remove());
  let o='';for(const c of clone.children)o+=_nodeToOoxml(c);return o;
}
async function gerarDocxBlob(){
  if(typeof JSZip==='undefined') throw new Error('JSZip n\\u00e3o carregado.');
  const T=tokens(),hasTimbra=chk('op_timbre');
  const content=_domToOoxml($('doc'));
  const WURI='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const RURI='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const PKURI='http://schemas.openxmlformats.org/package/2006/relationships';
  const hdrRefs=hasTimbra?\`<w:headerReference w:type="default" r:id="rId3"/><w:footerReference w:type="default" r:id="rId4"/>\`:'';
  const hdrDocRels=hasTimbra?\`<Relationship Id="rId3" Type="\${RURI}/header" Target="header1.xml"/><Relationship Id="rId4" Type="\${RURI}/footer" Target="footer1.xml"/>\`:'';
  const hdrOverrides=hasTimbra?\`<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>\`:'';
  const zip=new JSZip();
  zip.file('[Content_Types].xml',\`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>\${hdrOverrides}</Types>\`);
  zip.file('_rels/.rels',\`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="\${PKURI}"><Relationship Id="rId1" Type="\${RURI}/officeDocument" Target="word/document.xml"/></Relationships>\`);
  zip.file('word/_rels/document.xml.rels',\`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="\${PKURI}"><Relationship Id="rId1" Type="\${RURI}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="\${RURI}/settings" Target="settings.xml"/>\${hdrDocRels}</Relationships>\`);
  zip.file('word/styles.xml',\`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="\${WURI}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="23"/><w:szCs w:val="23"/><w:lang w:val="pt-BR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:jc w:val="both"/><w:spacing w:line="360" w:lineRule="auto" w:after="160"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>\`);
  zip.file('word/settings.xml',\`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="\${WURI}"><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>\`);
  zip.file('word/document.xml',\`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:r="\${RURI}" xmlns:w="\${WURI}"><w:body>\${content}<w:sectPr>\${hdrRefs}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1985" w:right="1080" w:bottom="1418" w:left="1080" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>\`);
  if(hasTimbra){
    const l1=_xmlEsc(subst(val('t_linha1'),T));
    const txt=subst(val('t_texto'),T).split(/\\n/).filter(Boolean).map(l=>\`<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:rPr><w:sz w:val="15"/></w:rPr><w:t>\${_xmlEsc(l)}</w:t></w:r></w:p>\`).join('');
    const rod=_xmlEsc(subst(val('t_rodape'),T));
    zip.file('word/header1.xml',\`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="\${WURI}"><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="16"/></w:rPr><w:t>\${l1}</w:t></w:r></w:p>\${txt}<w:p><w:pPr><w:spacing w:before="40" w:after="40"/><w:pBdr><w:top w:val="double" w:sz="6" w:space="4" w:color="9A9A9A"/><w:bottom w:val="double" w:sz="6" w:space="4" w:color="9A9A9A"/></w:pBdr></w:pPr></w:p></w:hdr>\`);
    zip.file('word/footer1.xml',\`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="\${WURI}"><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="40" w:after="0"/><w:pBdr><w:top w:val="double" w:sz="6" w:space="4" w:color="9A9A9A"/></w:pBdr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Garamond"/><w:i/><w:color w:val="7A4A1C"/><w:sz w:val="22"/></w:rPr><w:t>\${rod}</w:t></w:r></w:p></w:ftr>\`);
  }
  return zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
}`;

h = h.substring(0, os) + DOCX_CODE + h.substring(oe);
fs.writeFileSync('index.html', h, 'utf8');
console.log('Done. exportWord now at:', h.indexOf('function exportWord()'));
