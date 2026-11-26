import matplotlib
matplotlib.use("TkAgg")
import matplotlib.pyplot as plt
import numpy as np

x = np.linspace(-6, 6, 360)
y = np.linspace(-6, 6, 360)
xx, yy = np.meshgrid(x, y)
r1 = np.sqrt((xx + 1.4) ** 2 + yy**2)
r2 = np.sqrt((xx - 1.4) ** 2 + yy**2)
field = np.sin(3.2 * r1) + np.sin(3.2 * r2)
cross_section = np.sinc(x) * 2

plt.rcParams.update({"font.size": 12, "axes.titlesize": 16, "figure.dpi": 100})
fig, (left, right) = plt.subplots(1, 2, figsize=(11.2, 6.4), gridspec_kw={"width_ratios": [1, 1.2]})
fig.patch.set_facecolor("#f7f9fc")
fig.canvas.manager.set_window_title("waves.py · two-source interference")
image = left.imshow(field, cmap="twilight", origin="lower", extent=[-6, 6, -6, 6], vmin=-2, vmax=2)
left.set_title("interference of two point sources")
left.set_xlabel("x / wavelengths")
left.set_ylabel("y / wavelengths")
fig.colorbar(image, ax=left, shrink=0.78, label="amplitude")
right.plot(x, cross_section, color="#355c86", linewidth=2.4)
right.fill_between(x, cross_section, color="#7fb4df", alpha=0.18)
right.set_title("cross-section at y = 0")
right.set_xlabel("x / wavelengths")
right.set_ylabel("amplitude")
right.grid(alpha=0.22)
fig.suptitle("Fixed demonstration frame · remote matplotlib over SSH", fontsize=13, color="#53677b")
fig.tight_layout(rect=[0, 0, 1, 0.95])
plt.show()
