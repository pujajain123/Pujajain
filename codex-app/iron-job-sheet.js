/* Iron Work job sheet: the same fields as the "UMAMI STUDIO - IRON WORK JOB SHEET" spreadsheet,
   with a product photo per line, editable by admin and staff, downloadable as PDF or Excel. */
(function () {
  const SHEET_COLUMNS = [['sku', 'SKU'], ['product', 'Product Name'], ['qty', 'Qty'], ['dimensions', 'Dimensions'], ['material', 'Material'], ['pipeSection', 'Pipe Section'], ['finish', 'Finish']];
  const LIBS = {
    jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    autotable: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
    exceljs: 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js'
  };

  function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); }
  function longDate(d) { return d ? new Date(d + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'long' }) : ''; }

  function ensureSheet(j) {
    const { o, p } = j;
    if (p.sheet) return p.sheet;
    const lines = o.items?.length
      ? o.items.map((it, i) => ({ item: i, sku: it.sku || '', product: it.name || '', qty: it.qty ?? '', dimensions: it.dimensions || '', material: it.material || 'Iron', pipeSection: it.pipeSection || '', finish: it.powderColor || '', photoData: it.photoData || '' }))
      : [{ sku: '', product: o.product || '', qty: o.qty ?? '', dimensions: '', material: 'Iron', pipeSection: '', finish: '', photoData: o.photoData || '' }];
    p.sheet = { projectNo: o.client || '', date: o.orderDate || '', preparedBy: o.createdBy || '', jobSheetNo: o.id, expectedDelivery: p.due || o.deadline || '', projectName: o.product || '', lines };
    return p.sheet;
  }

  function headerField(id, key, label, value, type = 'text') {
    return `<label class="ijs-label">${label}</label><input class="ijs-input" type="${type}" data-ijs-job="${id}" data-ijs-key="${key}" value="${esc(value)}">`;
  }

  function lineRow(id, line, i) {
    const cell = (key, type = 'text') => `<td><input class="ijs-input" type="${type}" ${type === 'number' ? 'min="0"' : ''} data-ijs-job="${id}" data-ijs-line="${i}" data-ijs-key="${key}" value="${esc(line[key])}"></td>`;
    const photo = line.photoData
      ? `<img class="ijs-photo" src="${line.photoData}" alt="${esc(line.product)}">`
      : '<span class="ijs-photo empty">No photo</span>';
    return `<tr>${cell('sku')}<td class="ijs-product"><button type="button" class="ijs-photo-button" data-ijs-photo="${id}" data-ijs-line="${i}" title="Choose product photo">${photo}<span>${line.photoData ? 'Change photo' : '＋ Choose photo'}</span></button><input type="file" accept="image/*" hidden data-ijs-photo-input="${id}" data-ijs-line="${i}"><input class="ijs-input" data-ijs-job="${id}" data-ijs-line="${i}" data-ijs-key="product" value="${esc(line.product)}" placeholder="Product name"></td>${cell('qty', 'number')}${cell('dimensions')}${cell('material')}${cell('pipeSection')}${cell('finish')}<td class="ijs-remove-cell"><button type="button" class="ijs-remove" data-ijs-remove="${id}" data-ijs-line="${i}" title="Remove row" aria-label="Remove row">×</button></td></tr>`;
  }

  function sheetHtml(j) {
    const s = ensureSheet(j), id = j.id;
    return `<section class="panel iron-job-sheet" id="iron-job-sheet">
      <div class="panel-header"><div><h2>Iron work job sheet</h2><p>Changes save automatically. Admin and staff can download this sheet.</p></div>
        <div class="ijs-downloads"><button type="button" class="secondary-button" data-ijs-download="pdf" data-ijs-for="${id}">↓ PDF</button><button type="button" class="secondary-button" data-ijs-download="xlsx" data-ijs-for="${id}">↓ Excel</button></div></div>
      <div class="ijs-doc">
        <h3 class="ijs-title">UMAMI STUDIO - IRON WORK JOB SHEET</h3>
        <div class="ijs-head">
          ${headerField(id, 'projectNo', 'Project No.', s.projectNo)}${headerField(id, 'jobSheetNo', 'Job Sheet No.', s.jobSheetNo)}
          ${headerField(id, 'date', 'Date', s.date, 'date')}${headerField(id, 'expectedDelivery', 'Expected Delivery', s.expectedDelivery, 'date')}
          ${headerField(id, 'preparedBy', 'Prepared By', s.preparedBy)}<span></span><span></span>
        </div>
        <div class="ijs-project">${headerField(id, 'projectName', 'Project Name', s.projectName)}</div>
        <div class="ijs-table-wrap"><table class="ijs-table"><thead><tr>${SHEET_COLUMNS.map(([, l]) => `<th>${l}</th>`).join('')}<th></th></tr></thead>
          <tbody>${s.lines.map((l, i) => lineRow(id, l, i)).join('')}</tbody></table></div>
        <button type="button" class="compact-button ijs-add" data-ijs-add="${id}">＋ Add row</button>
      </div>
    </section>`;
  }

  const withIronSheet = openJob;
  openJob = function (id) {
    withIronSheet(id);
    const j = getJobs().find(x => x.id === id), drawer = document.querySelector('#overlay-root .drawer');
    if (!j || !drawer || j.p.name !== 'Iron Work') return;
    drawer.classList.remove('narrow');
    drawer.classList.add('wide');
    drawer.querySelector('.job-product-photos')?.remove();
    const anchor = drawer.querySelector('.modal-heading')?.nextElementSibling;
    (anchor || drawer.querySelector('.modal-heading')).insertAdjacentHTML('afterend', sheetHtml(j));
  };

  function jobFor(el, attr) { return getJobs().find(x => x.id === el.dataset[attr]); }
  function reopen(id) { const top = document.querySelector('#overlay-root .drawer')?.scrollTop || 0; openJob(id); const d = document.querySelector('#overlay-root .drawer'); if (d) d.scrollTop = top; }

  document.addEventListener('input', e => {
    const f = e.target.closest('[data-ijs-key]');
    if (!f) return;
    const j = jobFor(f, 'ijsJob');
    if (!j) return;
    const s = ensureSheet(j), key = f.dataset.ijsKey;
    if (f.dataset.ijsLine !== undefined) {
      const line = s.lines[Number(f.dataset.ijsLine)];
      if (line) line[key] = key === 'qty' && f.value !== '' ? Number(f.value) : f.value;
    } else s[key] = f.value;
    persist();
  });

  document.addEventListener('change', e => {
    const f = e.target.closest('[data-ijs-key]');
    if (f) { const j = jobFor(f, 'ijsJob'); if (j) addActivity(currentActor(), j.id, 'Iron work job sheet updated'), persist(); return; }
    const input = e.target.closest('[data-ijs-photo-input]');
    if (!input) return;
    const file = input.files?.[0], j = jobFor(input, 'ijsPhotoInput');
    if (!file || !j) return;
    const index = Number(input.dataset.ijsLine);
    toJpeg(file, 900).then(data => {
      const line = ensureSheet(j).lines[index];
      if (!line) return;
      line.photoData = data;
      if (line.item !== undefined && j.o.items?.[line.item]) j.o.items[line.item].photoData = data;
      else if (!j.o.items?.length && index === 0) j.o.photoData = data;
      addActivity(currentActor(), j.id, `Product photo chosen for ${line.sku || line.product || 'job sheet row ' + (index + 1)}`);
      persist();
      reopen(j.id);
      toast('Photo saved to the job sheet.');
    }).catch(() => toast('That image could not be read. Try a JPG or PNG.'));
  });

  document.addEventListener('click', e => {
    const pick = e.target.closest('[data-ijs-photo]');
    if (pick) { document.querySelector(`[data-ijs-photo-input="${pick.dataset.ijsPhoto}"][data-ijs-line="${pick.dataset.ijsLine}"]`)?.click(); return; }
    const add = e.target.closest('[data-ijs-add]');
    if (add) { const j = jobFor(add, 'ijsAdd'); if (!j) return; ensureSheet(j).lines.push({ sku: '', product: '', qty: '', dimensions: '', material: 'Iron', pipeSection: '', finish: '', photoData: '' }); persist(); reopen(j.id); return; }
    const rm = e.target.closest('[data-ijs-remove]');
    if (rm) { const j = jobFor(rm, 'ijsRemove'), s = j && ensureSheet(j); if (!s) return; if (s.lines.length === 1) { toast('A job sheet needs at least one row.'); return; } if (!confirm('Remove this row from the job sheet?')) return; s.lines.splice(Number(rm.dataset.ijsLine), 1); addActivity(currentActor(), j.id, 'Row removed from iron work job sheet'); persist(); reopen(j.id); return; }
    const dl = e.target.closest('[data-ijs-download]');
    if (dl) { const j = jobFor(dl, 'ijsFor'); if (j) download(j, dl.dataset.ijsDownload, dl); }
  });

  /* ---------- helpers ---------- */

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)?.dataset.loaded) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => { s.dataset.loaded = '1'; resolve(); };
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  function toJpeg(src, max) {
    return new Promise((resolve, reject) => {
      const url = typeof src === 'string' ? src : URL.createObjectURL(src);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        if (typeof src !== 'string') URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  function imageSize(data) {
    return new Promise(resolve => { const i = new Image(); i.onload = () => resolve({ w: i.width, h: i.height }); i.onerror = () => resolve({ w: 1, h: 1 }); i.src = data; });
  }

  async function preparedLines(s) {
    return Promise.all(s.lines.map(async l => {
      if (!l.photoData) return { ...l, jpeg: null };
      try { const jpeg = await toJpeg(l.photoData, 900); return { ...l, jpeg, size: await imageSize(jpeg) }; } catch (e) { return { ...l, jpeg: null }; }
    }));
  }

  async function saveFile(filename, blob) {
    if (window.claude?.use) {
      const downloads = await window.claude.use('downloads');
      if (downloads) {
        try { await downloads.save({ filename, data: blob }); return true; }
        catch (err) { if (err?.code === 'declined') return false; if (err?.code !== 'unavailable' && err?.code !== 'not_granted') { toast('Download failed: ' + (err?.message || 'unknown error')); return false; } }
      }
    }
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  }

  window.umamiSaveFile = saveFile;

  async function download(j, format, button) {
    const s = ensureSheet(j), label = button.textContent;
    button.disabled = true; button.textContent = 'Preparing…';
    try {
      const lines = await preparedLines(s);
      const name = `Iron-Job-Sheet-${(s.jobSheetNo || j.o.id).replace(/[^\w-]+/g, '-')}`;
      const blob = format === 'pdf' ? await buildPdf(s, lines) : await buildXlsx(s, lines);
      if (await saveFile(`${name}.${format}`, blob)) {
        addActivity(currentActor(), j.id, `Iron work job sheet downloaded (${format.toUpperCase()})`);
        persist();
      }
    } catch (err) {
      console.error(err);
      toast('The job sheet could not be prepared. Check your internet connection and try again.');
    } finally { button.disabled = false; button.textContent = label; }
  }

  async function buildPdf(s, lines) {
    await loadScript(LIBS.jspdf);
    await loadScript(LIBS.autotable);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.getWidth(), M = 12;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
    doc.text('UMAMI STUDIO - IRON WORK JOB SHEET', W / 2, 16, { align: 'center' });
    const box = (x, y, w, label, value) => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(label, x, y + 5);
      doc.setFont('helvetica', 'normal'); doc.rect(x + 34, y, w, 7); doc.text(String(value || ''), x + 36, y + 5);
    };
    const half = (W - 2 * M) / 2;
    box(M, 24, half - 40, 'Project No.', s.projectNo);
    box(M + half, 24, half - 40, 'Job Sheet No.', s.jobSheetNo);
    box(M, 31, half - 40, 'Date', longDate(s.date));
    box(M + half, 31, half - 40, 'Expected Delivery', longDate(s.expectedDelivery));
    box(M, 38, half - 40, 'Prepared By', s.preparedBy);
    box(M, 49, W - 2 * M - 34, 'Project Name', s.projectName);
    const photoH = 38;
    doc.autoTable({
      startY: 62,
      margin: { left: M, right: M },
      head: [SHEET_COLUMNS.map(([, l]) => l)],
      body: lines.map(l => [l.sku, l.product, l.qty, l.dimensions, l.material, l.pipeSection, l.finish].map(v => v == null ? '' : String(v))),
      theme: 'grid',
      styles: { font: 'helvetica', fontSize: 10, textColor: 20, lineColor: 30, lineWidth: 0.2, valign: 'bottom', cellPadding: 2 },
      headStyles: { fillColor: [232, 232, 232], textColor: 20, fontStyle: 'bold', valign: 'middle' },
      columnStyles: { 0: { cellWidth: 30 }, 1: { cellWidth: 62 }, 2: { cellWidth: 16, halign: 'right' } },
      didParseCell: d => { if (d.section === 'body' && lines[d.row.index].jpeg) d.cell.styles.minCellHeight = photoH + 9; },
      didDrawCell: d => {
        const l = lines[d.row.index];
        if (d.section !== 'body' || d.column.index !== 1 || !l?.jpeg) return;
        const maxW = d.cell.width - 4, ratio = l.size.w / l.size.h;
        let h = photoH, w = h * ratio;
        if (w > maxW) { w = maxW; h = w / ratio; }
        doc.addImage(l.jpeg, 'JPEG', d.cell.x + 2, d.cell.y + 2, w, h);
      }
    });
    return doc.output('blob');
  }

  async function buildXlsx(s, lines) {
    await loadScript(LIBS.exceljs);
    const wb = new window.ExcelJS.Workbook();
    const ws = wb.addWorksheet('Iron Job Sheet', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    ws.columns = [{ width: 16 }, { width: 40 }, { width: 8 }, { width: 22 }, { width: 18 }, { width: 18 }, { width: 18 }];
    const thin = { style: 'thin', color: { argb: 'FF000000' } }, border = { top: thin, left: thin, bottom: thin, right: thin };
    ws.mergeCells('A2:G2');
    Object.assign(ws.getCell('A2'), { value: 'UMAMI STUDIO - IRON WORK JOB SHEET' });
    ws.getCell('A2').font = { bold: true, size: 16 }; ws.getCell('A2').alignment = { horizontal: 'center' };
    const pair = (labelRef, valueRange, label, value) => {
      const l = ws.getCell(labelRef); l.value = label; l.font = { bold: true };
      if (valueRange.split(':')[0] !== valueRange.split(':')[1]) ws.mergeCells(valueRange);
      const v = ws.getCell(valueRange.split(':')[0]); v.value = value || ''; v.border = border;
    };
    pair('A4', 'B4:B4', 'Project No.', s.projectNo);
    pair('D4', 'E4:F4', 'Job Sheet No.', s.jobSheetNo);
    pair('A5', 'B5:B5', 'Date', longDate(s.date));
    pair('D5', 'E5:F5', 'Expected Delivery', longDate(s.expectedDelivery));
    pair('A6', 'B6:B6', 'Prepared By', s.preparedBy);
    pair('A8', 'B8:G8', 'Project Name', s.projectName);
    ws.getCell('B8').alignment = { horizontal: 'center' };
    const head = ws.getRow(10);
    SHEET_COLUMNS.forEach(([, l], i) => { const c = head.getCell(i + 1); c.value = l; c.font = { bold: true }; c.border = border; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } }; });
    lines.forEach((l, i) => {
      const row = ws.getRow(11 + i);
      [l.sku, l.product, l.qty === '' ? '' : l.qty, l.dimensions, l.material, l.pipeSection, l.finish].forEach((v, k) => { const c = row.getCell(k + 1); c.value = v ?? ''; c.border = border; c.alignment = { vertical: 'bottom', wrapText: true }; });
      if (l.jpeg) {
        row.height = 150;
        const id = wb.addImage({ base64: l.jpeg, extension: 'jpeg' });
        const maxW = 270, maxH = 160, ratio = l.size.w / l.size.h;
        let h = maxH, w = h * ratio;
        if (w > maxW) { w = maxW; h = w / ratio; }
        ws.addImage(id, { tl: { col: 1.05, row: 10 + i + 0.05 }, ext: { width: w, height: h } });
        row.getCell(2).alignment = { vertical: 'bottom', wrapText: true };
      }
    });
    const buf = await wb.xlsx.writeBuffer();
    return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
})();
