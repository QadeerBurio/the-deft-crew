from PIL import Image
import os

def main():
    img_path = r"c:\Users\PMYLS\Desktop\The deft crew\Frontend\assets\travel_mascot.png"
    print(f"Opening image: {img_path}")
    if not os.path.exists(img_path):
        print("Error: Image path does not exist.")
        return
        
    im = Image.open(img_path)
    print(f"Original size: {im.size}")
    
    # getbbox returns the bounding box of non-zero (non-transparent) pixels
    bbox = im.getbbox()
    if bbox:
        print(f"Bounding box: {bbox}")
        cropped = im.crop(bbox)
        # Add a small padding (e.g. 5% of width/height) around the cropped area to prevent clipping
        w, h = cropped.size
        pad_w = int(w * 0.05)
        pad_h = int(h * 0.05)
        padded_im = Image.new("RGBA", (w + 2*pad_w, h + 2*pad_h), (0, 0, 0, 0))
        padded_im.paste(cropped, (pad_w, pad_h))
        
        padded_im.save(img_path)
        print(f"Successfully cropped and saved. New size: {padded_im.size}")
    else:
        print("Error: Could not determine bounding box (image might be fully transparent).")

if __name__ == "__main__":
    main()
