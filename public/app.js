// Small progressive enhancements: gallery thumbnails and upload previews.
(function () {
  const main = document.getElementById('main-img');
  document.querySelectorAll('.thumbs img').forEach((t) => {
    t.addEventListener('click', () => {
      if (main) main.src = t.dataset.full;
      document.querySelectorAll('.thumbs img').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
    });
  });

  const input = document.getElementById('image-input');
  const preview = document.getElementById('image-preview');
  if (input && preview) {
    input.addEventListener('change', () => {
      preview.innerHTML = '';
      Array.from(input.files).slice(0, 8).forEach((f) => {
        if (!f.type.startsWith('image/')) return;
        const url = URL.createObjectURL(f);
        const div = document.createElement('div');
        div.className = 'img-item';
        div.innerHTML = '<img alt=""><div class="muted">' + (Math.round(f.size / 1024)) + ' KB</div>';
        div.querySelector('img').src = url;
        preview.appendChild(div);
      });
    });
  }
})();
