#include <inttypes.h>
#include <stdlib.h>
#include <string.h>
#include "esp_check.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "led_strip.h"
#include "protocol.h"

static const char *TAG = "mapper3d";
static const uint8_t colors[MAPPER_COLORS][3] = {
    {1, 0, 0}, {0, 1, 0}, {0, 0, 1},
    {1, 1, 0}, {1, 0, 1}
};

typedef struct {
    uint8_t r, g, b;
} rgb_color_t;

static rgb_color_t reorder_color(rgb_color_t rgb, const char *order) {
    rgb_color_t result = {0, 0, 0};
    for (int i = 0; i < 3; i++) {
        switch (order[i]) {
            case 'R': result.r = (i == 0) ? rgb.r : (i == 1) ? rgb.g : rgb.b; break;
            case 'G': result.g = (i == 0) ? rgb.r : (i == 1) ? rgb.g : rgb.b; break;
            case 'B': result.b = (i == 0) ? rgb.r : (i == 1) ? rgb.g : rgb.b; break;
        }
    }
    return result;
}

static void startup_flash_sequence(led_strip_handle_t strip, unsigned int count) {
    const uint8_t flash_colors[3][3] = {
        {255, 0, 0},    // Red
        {0, 255, 0},    // Green
        {0, 0, 255}     // Blue
    };
    const char *color_order = CONFIG_MAPPER_LED_COLOR_ORDER;
    
    for (int color_idx = 0; color_idx < 3; color_idx++) {
        rgb_color_t rgb = {flash_colors[color_idx][0], flash_colors[color_idx][1], flash_colors[color_idx][2]};
        rgb_color_t ordered = reorder_color(rgb, color_order);
        
        for (unsigned int i = 0; i < count; i++) {
            ESP_ERROR_CHECK(led_strip_set_pixel(strip, i,
                ordered.r * CONFIG_MAPPER_LED_BRIGHTNESS / 255,
                ordered.g * CONFIG_MAPPER_LED_BRIGHTNESS / 255,
                ordered.b * CONFIG_MAPPER_LED_BRIGHTNESS / 255));
        }
        ESP_ERROR_CHECK(led_strip_refresh(strip));
        vTaskDelay(pdMS_TO_TICKS(350));
    }
    
    // Turn off all LEDs after flash sequence
    for (unsigned int i = 0; i < count; i++) {
        ESP_ERROR_CHECK(led_strip_set_pixel(strip, i, 0, 0, 0));
    }
    ESP_ERROR_CHECK(led_strip_refresh(strip));
}

void app_main(void)
{
    const unsigned int count = CONFIG_MAPPER_LED_COUNT;
    const int64_t period_us = count <= 2000 ? 120000 : 360000;
    uint8_t (*words)[MAPPER_CODE_WORDS] = malloc(count * sizeof(*words));
    if (!words) {
        ESP_LOGE(TAG, "Insufficient memory for %u LED codewords", count);
        return;
    }
    for (unsigned int i = 0; i < count; ++i) {
        if (!mapper_encode(i, count, words[i])) {
            ESP_LOGE(TAG, "Failed to encode LED %u", i);
            free(words);
            return;
        }
    }
    led_strip_config_t strip_config = {
        .strip_gpio_num = CONFIG_MAPPER_LED_GPIO,
        .max_leds = count,
        .led_model = LED_MODEL_WS2812,
        .led_pixel_format = LED_PIXEL_FORMAT_GRB,
    };
    led_strip_rmt_config_t rmt_config = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10000000,
        .mem_block_symbols = 64,
        .flags.with_dma = false,
    };
    led_strip_handle_t strip;
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&strip_config, &rmt_config, &strip));
    
    #if CONFIG_MAPPER_STARTUP_FLASH_COLORS
    ESP_LOGI(TAG, "Running startup flash sequence (R, G, B for 350ms each)");
    startup_flash_sequence(strip, count);
    #endif
    
    ESP_LOGI(TAG, "Encoding %u LEDs; symbol period %" PRId64 " ms", count, period_us / 1000);
    int64_t deadline = esp_timer_get_time();
    for (unsigned int position = 0;; position = (position + 1) % MAPPER_FRAME_SYMBOLS) {
        for (unsigned int i = 0; i < count; ++i) {
            const uint8_t *color = colors[mapper_frame_symbol(words[i], position)];
            ESP_ERROR_CHECK(led_strip_set_pixel(strip, i,
                color[0] * CONFIG_MAPPER_LED_BRIGHTNESS,
                color[1] * CONFIG_MAPPER_LED_BRIGHTNESS,
                color[2] * CONFIG_MAPPER_LED_BRIGHTNESS));
        }
        ESP_ERROR_CHECK(led_strip_refresh(strip));
        deadline += period_us;
        int64_t remaining = deadline - esp_timer_get_time();
        if (remaining <= 0) {
            ESP_LOGE(TAG, "LED update exceeded symbol period; stopping");
            ESP_ERROR_CHECK(led_strip_clear(strip));
            free(words);
            return;
        }
        vTaskDelay(pdMS_TO_TICKS((remaining + 999) / 1000));
    }
}
