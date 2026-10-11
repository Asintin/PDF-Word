'use strict';

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const selectBtn = document.getElementById('selectBtn');
const langSelect = document.getElementById('langSelect');
const fileList = document.getElementById('fileList');
const progress = document.getElementById('progress');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const results = document.getElementById('results');

let files = [];

selectBtn.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('click', (e) => {
  if (e.target === selectBtn) return;
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  addFiles(Array.from(fileInput.files));
  fileInput.value = '';
});

['dragenter', 'dragover'].forEach((ev) => dropZone.addEventListener(ev, (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((ev) => dropZone.addEventListener(ev, (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
}));
dropZone.addEventListener('drop', (e) => {
  addFiles(Array.from(e.dataTransfer.files));
});

function addFiles(list) {
  const pdfs = list.filter((f) => /\.pdf$/i.test(f.name));
  if (pdfs.length === 0) { alert('请选择 PDF 文件'); return; }
  files = files.concat(pdfs);
  renderFileList();
}

function renderFileList() {
  fileList.innerHTML = '';
  files.forEach((f, idx) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `
      <span class="fname">${escapeHtml(f.name)}</span>
      <span class="fstatus" id="status-${idx}">待转换</span>
      <button class="remove" data-idx="${idx}">移除</button>
    `;
    item.querySelector('.remove').addEventListener('click', () => {
      files.splice(idx, 1);
      renderFileList();
    });
    fileList.appendChild(item);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setStatus(idx, text, cls) {
  const el = document.getElementById(`status-${idx}`);
  if (el) { el.textContent = text; el.className = 'fstatus ' + (cls || ''); }
}

async function convertAll() {
  if (files.length === 0) return;
  progress.classList.remove('hidden');
  progressFill.className = 'progress-fill indeterminate';
  progressText.textContent = '准备开始…';

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    setStatus(i, '转换中…', '');
    progressText.textContent = `正在转换 (${i + 1}/${files.length}): ${f.name}`;
    try {
      const buf = await f.arrayBuffer();
      const resp = await fetch(`/convert?lang=${encodeURIComponent(langSelect.value)}&name=${encodeURIComponent(f.name)}`, {
        method: 'POST',
        body: buf,
        headers: { 'Content-Type': 'application/pdf' },
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || '转换失败');
      setStatus(i, '已完成', 'ok');
      results.appendChild(resultItem(data));
    } catch (err) {
      setStatus(i, '失败', 'err');
      results.appendChild(errorItem(f.name, err.message));
    }
  }

  progress.classList.add('hidden');
  progressText.textContent = '';
}

function resultItem(data) {
  const div = document.createElement('div');
  div.className = 'file-item';
  div.innerHTML = `
    <span class="fname">✅ ${escapeHtml(data.fileName)}</span>
    <span class="fstatus ok">已保存</span>
    <button class="open">打开文件</button>
    <button class="openfolder">打开所在文件夹</button>
  `;
  div.querySelector('.open').addEventListener('click', () => fetch(`/open?path=${encodeURIComponent(data.file)}`));
  div.querySelector('.openfolder').addEventListener('click', () => fetch(`/openfolder?path=${encodeURIComponent(data.file)}`));
  return div;
}

function errorItem(name, msg) {
  const div = document.createElement('div');
  div.className = 'file-item';
  div.innerHTML = `<span class="fname">❌ ${escapeHtml(name)}</span><span class="fstatus err">${escapeHtml(msg)}</span>`;
  return div;
}

// Auto convert button
const convertBtn = document.createElement('button');
convertBtn.textContent = '开始转换';
convertBtn.className = 'btn-secondary';
convertBtn.style.marginTop = '16px';
convertBtn.style.width = '100%';
convertBtn.style.background = '#2f6fed';
convertBtn.style.color = '#fff';
convertBtn.style.border = 'none';
convertBtn.style.padding = '12px';
convertBtn.style.fontSize = '16px';
convertBtn.addEventListener('click', convertAll);
fileList.after(convertBtn);
